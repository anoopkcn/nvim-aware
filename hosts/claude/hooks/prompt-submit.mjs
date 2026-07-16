#!/usr/bin/env node
/**
 * UserPromptSubmit hook — decides, per prompt, whether to inject live Neovim
 * editor state, honoring NVIM_AWARE_PROMPT_CONTEXT (auto | full | hint | off).
 *
 *   auto (default): inject a compact snapshot only when the prompt looks like
 *                   it refers to editor state (cheap — nothing otherwise).
 *   full:           inject a compact snapshot on every prompt.
 *   hint:           never inject state; just remind Claude the tool exists.
 *   off:            do nothing.
 */
import {
	getExplicitServer,
	getPromptContextMode,
	getPromptRefreshTimeoutMs,
	isDisabled,
	promptLikelyNeedsNvimContext,
} from "../core/config.mjs";
import { resolveServer } from "../core/discover.mjs";
import { getNvimSnapshot } from "../core/snapshot.mjs";
import { formatOnDemandSystemPromptContext, formatSystemPromptContext } from "../core/format.mjs";
import { errorToMessage } from "../core/proc.mjs";
import { emitContext, readHookInput } from "../lib/hookio.mjs";

const EVENT = "UserPromptSubmit";

async function main() {
	if (isDisabled()) return;

	const mode = getPromptContextMode();
	if (mode === "off") return;

	const input = await readHookInput();
	const cwd = input.cwd || process.cwd();
	const prompt = input.prompt || "";
	const explicit = getExplicitServer();

	const shouldInject = mode === "full" || (mode === "auto" && promptLikelyNeedsNvimContext(prompt));

	// hint mode (or auto without a match): at most a lightweight reminder.
	if (!shouldInject) {
		if (mode !== "hint") return; // auto, no keyword -> stay silent (no tokens spent)
		try {
			const { server } = await resolveServer({ explicit, cwd });
			emitContext(EVENT, formatOnDemandSystemPromptContext(server));
		} catch {
			// No Neovim — say nothing.
		}
		return;
	}

	// shouldInject: fetch and inject a compact live snapshot.
	try {
		const { server } = await resolveServer({ explicit, cwd });
		const timeoutMs = Math.max(getPromptRefreshTimeoutMs(), 1500);
		const snapshot = await getNvimSnapshot(server, { timeoutMs });
		emitContext(EVENT, formatSystemPromptContext(snapshot));
	} catch (error) {
		// Injection was expected (full mode or the prompt referenced editor state),
		// so surface a one-line note rather than failing silently.
		emitContext(EVENT, `Neovim context was requested, but it could not be read: ${errorToMessage(error)}`);
	}
}

main().catch(() => process.exit(0));
