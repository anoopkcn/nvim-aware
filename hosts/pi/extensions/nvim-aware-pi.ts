/**
 * nvim-aware-pi extension — thin Pi host glue over the shared core.
 *
 * When enabled with `--nvim`, connects to a running Neovim server and injects
 * live editor context into Pi's system prompt. Also provides an `nvim_context`
 * tool so agents can refresh editor state while working on a request.
 *
 * Injection is governed by NVIM_AWARE_PROMPT_CONTEXT and NVIM_AWARE_DISABLE,
 * via the same decision the Claude host uses. Under the default `auto`, a turn
 * only gets editor state when the prompt reaches for it.
 *
 * This source imports the shared core via relative paths and only works from
 * a checkout of the monorepo. The distributable single-file build lives in
 * ../dist/nvim-aware-pi.ts (regenerate with `npm run build`).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// @ts-ignore -- plain-JS core modules, resolved relative to the repo checkout
import { readConfig } from "../../../core/config.mjs";
// @ts-ignore
import { decideInjection } from "../../../core/injection.mjs";
// @ts-ignore
import { createNvimSession } from "../../../core/session.mjs";
// @ts-ignore
import { errorToMessage } from "../../../core/proc.mjs";
// @ts-ignore
import { LIMIT_DEFAULTS } from "../../../core/snapshot.mjs";
// @ts-ignore
import { formatOnDemandSystemPromptContext, formatSnapshot, formatSystemPromptContext } from "../../../core/format.mjs";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export default function (pi: ExtensionAPI) {
	pi.registerFlag("nvim", {
		description: "Inject live context from a running Neovim instance",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("nvim-server", {
		description: "Neovim server address to use with --nvim (from :echo v:servername)",
		type: "string",
	});

	let enabled = false;
	let session: ReturnType<typeof createNvimSession> | null = null;

	/**
	 * Created on demand so `/nvim` and an explicit tool call still work without
	 * `--nvim`: an explicit request is not automatic injection.
	 */
	const ensureSession = () => {
		if (session) return session;
		const config = readConfig();
		session = createNvimSession({
			explicitServer: asNonEmptyString(pi.getFlag("nvim-server")) ?? config.server,
			cwd: () => process.cwd(),
			defaultTimeoutMs: 2000,
			ttlMs: config.snapshotTtlMs,
			staleTimeoutMs: config.promptTimeoutMs,
		});
		return session;
	};

	pi.on("session_start", async (_event, ctx) => {
		const config = readConfig();
		// Two switches: the flag opts in, NVIM_AWARE_DISABLE overrides it.
		enabled = pi.getFlag("nvim") === true && !config.disabled;

		const activeTools = pi.getActiveTools();
		if (enabled && !activeTools.includes("nvim_context")) {
			pi.setActiveTools([...activeTools, "nvim_context"]);
		} else if (!enabled && activeTools.includes("nvim_context")) {
			pi.setActiveTools(activeTools.filter((tool) => tool !== "nvim_context"));
			ctx.ui.setStatus("nvim", undefined);
		}

		if (!enabled) return;

		try {
			const { server, candidateCount } = await ensureSession().connection();
			await ensureSession().snapshot(); // warm the cache for the first turn
			setNvimStatus(ctx, candidateCount);
			ctx.ui.notify(`Connected to Neovim: ${server}`, "info");
		} catch (error) {
			ctx.ui.setStatus("nvim", ctx.ui.theme.fg("warning", "nvim: not connected"));
			ctx.ui.notify(errorToMessage(error), "warning");
		}
	});

	pi.registerCommand("nvim", {
		description: "Show the live Neovim context Pi sees",
		handler: async (_args, ctx) => {
			try {
				const active = ensureSession();
				const snapshot = await active.snapshot({ force: true });
				setNvimStatus(ctx, (await active.connection()).candidateCount);
				ctx.ui.setWidget("nvim-context", formatSnapshot(snapshot, { compact: false }), {
					placement: "belowEditor",
				});
			} catch (error) {
				ctx.ui.notify(errorToMessage(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "nvim_context",
		label: "Nvim Context",
		description:
			"Get live context from the connected Neovim instance: current file, cursor, selection, search register, quickfix list, windows, and listed buffers.",
		promptSnippet: "Fetch live Neovim editor context: current file, cursor, selection, search, quickfix, windows, and buffers.",
		promptGuidelines: [
			"Use nvim_context when the user refers to the current Neovim file, cursor, visual selection, quickfix list, errors/warnings, open buffers, current search, or says things like 'this code' without naming a path.",
			"When Neovim context includes absolute paths, prefer those exact paths with read/edit/write tools instead of guessing from Pi's current directory.",
		],
		parameters: Type.Object({
			includeSurroundingLines: Type.Optional(
				Type.Boolean({ description: "Include a small snippet around the cursor. Defaults to true." }),
			),
			maxSelectionBytes: Type.Optional(
				Type.Number({ description: "Maximum bytes of selected text to return. Defaults to 4000." }),
			),
		}),
		async execute(_toolCallId, params) {
			const snapshot = await ensureSession().snapshot({
				force: true,
				limits: {
					surroundingLines: params.includeSurroundingLines === false ? 0 : LIMIT_DEFAULTS.surroundingLines,
					maxSelectionBytes: params.maxSelectionBytes ?? LIMIT_DEFAULTS.maxSelectionBytes,
				},
			});

			return {
				content: [{ type: "text", text: formatSnapshot(snapshot, { compact: false }).join("\n") }],
				details: snapshot as unknown as Record<string, JsonValue>,
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || !session) return;

		const decision = decideInjection({ prompt: event.prompt ?? "", config: readConfig() });
		// Under `auto`, a turn that does not reach for the editor costs nothing.
		if (decision.kind === "none") return;

		try {
			if (decision.kind === "hint") {
				const { server, candidateCount } = await session.connection();
				setNvimStatus(ctx, candidateCount);
				return { systemPrompt: `${event.systemPrompt}\n\n${formatOnDemandSystemPromptContext(server)}` };
			}

			const { snapshot, stale, warning } = await session.snapshotOrStale();
			setNvimStatus(ctx, (await session.connection()).candidateCount, stale ? "cached" : "connected");
			const note = warning ? `\n- Note: Snapshot refresh failed (${warning}); using cached Neovim context.` : "";
			return { systemPrompt: `${event.systemPrompt}\n\n${formatSystemPromptContext(snapshot)}${note}` };
		} catch (error) {
			ctx.ui.setStatus("nvim", ctx.ui.theme.fg("warning", "nvim: disconnected"));
			return {
				systemPrompt: `${event.systemPrompt}\n\nNeovim context requested, but Pi could not read it: ${errorToMessage(error)}`,
			};
		}
	});
}

function setNvimStatus(ctx: ExtensionContext, candidateCount: number, state = "connected") {
	const suffix = candidateCount > 1 ? ` +${candidateCount - 1}` : "";
	const color = state === "connected" ? "accent" : "warning";
	ctx.ui.setStatus("nvim", ctx.ui.theme.fg(color, `nvim: ${state}${suffix}`));
}

function asNonEmptyString(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
