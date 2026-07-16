/**
 * nvim-aware-pi extension — thin Pi host glue over the shared core.
 *
 * When enabled with `--nvim`, discovers or connects to a running Neovim
 * server, captures the active buffer, cursor, selection, search register,
 * quickfix list, windows, and listed buffers, then injects that live editor
 * context into Pi's system prompt. Also provides an `nvim_context` tool so
 * agents can refresh editor state while working on the user's request.
 *
 * This source imports the shared core via relative paths and only works from
 * a checkout of the monorepo. The distributable single-file build lives in
 * ../dist/nvim-aware-pi.ts (regenerate with `npm run build`).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// @ts-ignore -- plain-JS core modules, resolved relative to the repo checkout
import { getExplicitServer, getPromptRefreshTimeoutMs, getSnapshotTtlMs } from "../../../core/config.mjs";
// @ts-ignore
import { resolveServer } from "../../../core/discover.mjs";
// @ts-ignore
import { errorToMessage } from "../../../core/proc.mjs";
// @ts-ignore
import {
	DEFAULT_MAX_SELECTION_BYTES,
	DEFAULT_SURROUNDING_LINES,
	getCachedNvimSnapshot,
	getPromptNvimSnapshot,
} from "../../../core/snapshot.mjs";
// @ts-ignore
import { formatSnapshot, formatSystemPromptContext } from "../../../core/format.mjs";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ServerChoice = {
	server: string;
	candidateCount: number;
};

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
	let choice: ServerChoice | null = null;

	const explicitServer = () =>
		asNonEmptyString(pi.getFlag("nvim-server")) ?? getExplicitServer();

	const ensureConnected = async (ctx?: ExtensionContext): Promise<ServerChoice> => {
		const resolved = await resolveServer({ explicit: explicitServer(), cwd: process.cwd() });
		choice = { server: resolved.server, candidateCount: resolved.candidateCount };

		if (ctx) {
			await getCachedNvimSnapshot(resolved.server, {}, { ttlMs: getSnapshotTtlMs() });
			setNvimStatus(ctx, resolved.candidateCount);
		}

		return choice;
	};

	pi.on("session_start", async (_event, ctx) => {
		enabled = pi.getFlag("nvim") === true;

		const activeTools = pi.getActiveTools();
		if (enabled && !activeTools.includes("nvim_context")) {
			pi.setActiveTools([...activeTools, "nvim_context"]);
		} else if (!enabled && activeTools.includes("nvim_context")) {
			pi.setActiveTools(activeTools.filter((tool) => tool !== "nvim_context"));
			ctx.ui.setStatus("nvim", undefined);
		}

		if (!enabled) return;

		try {
			await ensureConnected(ctx);
			ctx.ui.notify(`Connected to Neovim: ${choice?.server}`, "info");
		} catch (error) {
			ctx.ui.setStatus("nvim", ctx.ui.theme.fg("warning", "nvim: not connected"));
			ctx.ui.notify(errorToMessage(error), "warning");
		}
	});

	pi.registerCommand("nvim", {
		description: "Show the live Neovim context Pi sees",
		handler: async (_args, ctx) => {
			try {
				const selected = choice ?? (await ensureConnected(ctx));
				const snapshot = await getCachedNvimSnapshot(selected.server, {}, { force: true });
				setNvimStatus(ctx, selected.candidateCount);
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
			const selected = choice ?? (await ensureConnected());
			const snapshot = await getCachedNvimSnapshot(
				selected.server,
				{
					surroundingLines: params.includeSurroundingLines === false ? 0 : DEFAULT_SURROUNDING_LINES,
					maxSelectionBytes: params.maxSelectionBytes ?? DEFAULT_MAX_SELECTION_BYTES,
				},
				{ force: true },
			);

			return {
				content: [{ type: "text", text: formatSnapshot(snapshot, { compact: false }).join("\n") }],
				details: snapshot as unknown as Record<string, JsonValue>,
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;

		try {
			const selected = choice ?? (await ensureConnected(ctx));
			const { snapshot, warning } = await getPromptNvimSnapshot(selected.server, {
				ttlMs: getSnapshotTtlMs(),
				refreshTimeoutMs: getPromptRefreshTimeoutMs(),
			});
			setNvimStatus(ctx, selected.candidateCount, warning ? "cached" : "connected");
			const cacheNote = warning ? `\n- Note: Snapshot refresh failed (${warning}); using cached Neovim context.` : "";

			return {
				systemPrompt: `${event.systemPrompt}\n\n${formatSystemPromptContext(snapshot)}${cacheNote}`,
			};
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
