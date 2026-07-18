#!/usr/bin/env node
/**
 * SessionStart hook — best-effort connects to a Neovim server and announces it
 * so Claude knows the `nvim_context` tool is available. In `full` mode it
 * preloads a snapshot.
 */
import { readConfig } from "../core/config.mjs";
import { decideSessionInjection } from "../core/injection.mjs";
import { createNvimSession } from "../core/session.mjs";
import { formatOnDemandSystemPromptContext, formatSystemPromptContext } from "../core/format.mjs";
import { emitContext, readHookInput } from "../lib/hookio.mjs";

const EVENT = "SessionStart";

async function main() {
	const config = readConfig();
	const decision = decideSessionInjection({ config });
	if (decision.kind === "none") return;

	const input = await readHookInput();
	const session = createNvimSession({
		explicitServer: config.server,
		cwd: input.cwd || process.cwd(),
		defaultTimeoutMs: 1500,
	});

	let server;
	try {
		server = await session.server();
	} catch {
		// No Neovim running — nothing to announce.
		return;
	}

	if (decision.kind === "snapshot") {
		try {
			emitContext(EVENT, formatSystemPromptContext(await session.snapshot()));
			return;
		} catch {
			// Connected but unreadable: degrading to the reminder is a host
			// recovery choice, not part of the shared decision.
		}
	}

	emitContext(EVENT, formatOnDemandSystemPromptContext(server));
}

main().catch(() => process.exit(0));
