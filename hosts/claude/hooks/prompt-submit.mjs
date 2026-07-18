#!/usr/bin/env node
/**
 * UserPromptSubmit hook — injects live Neovim state when the turn calls for it.
 *
 * What "calls for it" means lives in core/injection.mjs, shared with the Pi
 * host; this file only carries out the decision.
 */
import { readConfig } from "../core/config.mjs";
import { decideInjection } from "../core/injection.mjs";
import { createNvimSession } from "../core/session.mjs";
import { formatOnDemandSystemPromptContext, formatSystemPromptContext } from "../core/format.mjs";
import { errorToMessage } from "../core/proc.mjs";
import { emitContext, readHookInput } from "../lib/hookio.mjs";

const EVENT = "UserPromptSubmit";

async function main() {
	const config = readConfig();
	// Exit before touching stdin when no prompt could change the outcome.
	if (config.disabled || config.promptContextMode === "off") return;

	const input = await readHookInput();
	const decision = decideInjection({ prompt: input.prompt ?? "", config });
	if (decision.kind === "none") return;

	const session = createNvimSession({
		explicitServer: config.server,
		cwd: input.cwd || process.cwd(),
		defaultTimeoutMs: Math.max(config.promptTimeoutMs, 1500),
	});

	if (decision.kind === "hint") {
		try {
			emitContext(EVENT, formatOnDemandSystemPromptContext(await session.server()));
		} catch {
			// No Neovim — say nothing.
		}
		return;
	}

	try {
		emitContext(EVENT, formatSystemPromptContext(await session.snapshot()));
	} catch (error) {
		// Injection was expected — either the mode is `full` or the prompt
		// reached for the editor — so a silent no-op would be misleading.
		emitContext(EVENT, `Neovim context was requested, but it could not be read: ${errorToMessage(error)}`);
	}
}

main().catch(() => process.exit(0));
