// GENERATED FILE — do not edit. Source: core/discover.mjs. Regenerate with `npm run build` (or `node scripts/build.mjs`).
/**
 * Neovim server discovery + selection.
 *
 * Candidate sources, in order:
 *   explicit address  ->  $NVIM  ->  $NVIM_LISTEN_ADDRESS  ->  serverlist()
 *   ->  (fallback) socket-file scan of $XDG_RUNTIME_DIR / $TMPDIR / /tmp
 *
 * Everything that spawns or touches the filesystem goes through the transport,
 * so discovery is exercisable without a running editor.
 */
import { errorToMessage, isInside, mapWithConcurrency, uniqueStrings } from "./proc.mjs";
import { summaryRequest, toSummary } from "./snapshot.mjs";
import { createSpawnTransport } from "./transport.mjs";

const PROBE_CONCURRENCY = 4;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;

/** Fast candidate addresses (no socket scan). */
async function fastCandidates(explicit, transport, env) {
	if (explicit) return [explicit];
	return uniqueStrings([env.NVIM, env.NVIM_LISTEN_ADDRESS, ...(await transport.listServers())]);
}

/** Probe a list of servers for their summaries, with bounded concurrency. */
async function probeSummaries(candidates, { transport, timeoutMs }) {
	return mapWithConcurrency(candidates, PROBE_CONCURRENCY, async (server) => {
		try {
			const raw = await transport.evaluate(server, summaryRequest(), { timeoutMs });
			return { server, summary: toSummary(raw, { server }) };
		} catch (error) {
			return { server, error: errorToMessage(error) };
		}
	});
}

/** Pick the server most relevant to `cwd`: exact cwd, then file proximity, then containment. */
export function chooseBestNvimServer(items, cwd) {
	const best = items.find((item) => item.cwd === cwd) ??
		items.find((item) => isInside(cwd, item.currentFile)) ??
		items.find((item) => isInside(item.cwd, cwd)) ??
		items[0];
	if (!best) throw new Error("No Neovim server candidates responded");
	return best;
}

/**
 * Collect summaries for every responding server.
 * Tries fast candidates first, falling back to a socket scan when nothing responds.
 * Returns { summaries, failures, candidateCount }.
 */
export async function collectServerSummaries(options = {}) {
	const transport = options.transport ?? createSpawnTransport();
	const env = options.env ?? process.env;
	const explicit = options.explicit;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

	const fast = await fastCandidates(explicit, transport, env);
	let results = fast.length > 0 ? await probeSummaries(fast, { transport, timeoutMs }) : [];
	let summaries = results.flatMap((r) => (r.summary ? [r.summary] : []));

	if (!explicit && summaries.length === 0) {
		const scanned = uniqueStrings((await transport.scanSocketFiles()).filter((s) => !fast.includes(s)));
		if (scanned.length > 0) {
			results = [...results, ...(await probeSummaries(scanned, { transport, timeoutMs }))];
			summaries = results.flatMap((r) => (r.summary ? [r.summary] : []));
		}
	}

	const failures = results.flatMap((r) => (r.error ? [`${r.server}: ${r.error}`] : []));
	return { summaries, failures, candidateCount: summaries.length };
}

/**
 * Resolve the single best server for a given cwd (non-interactive).
 * Throws a descriptive error when no server is found / responds.
 *
 * An explicit address is trusted without a probe round-trip — the follow-up
 * snapshot fetch surfaces any connection failure with the same error handling.
 */
export async function resolveServer(options = {}) {
	const explicit = options.explicit;
	if (explicit) return { server: explicit, candidateCount: 1 };

	const cwd = options.cwd ?? process.cwd();

	const { summaries, failures, candidateCount } = await collectServerSummaries({
		transport: options.transport,
		env: options.env,
		timeoutMs: options.timeoutMs,
	});

	if (summaries.length === 0) {
		if (failures.length > 0) {
			throw new Error(`Found Neovim server candidates, but none responded. ${failures.join("; ")}`);
		}
		throw new Error(
			"No Neovim server found. Start Neovim normally, or run `nvim --listen /tmp/nvim-main` and set NVIM_AWARE_SERVER=/tmp/nvim-main.",
		);
	}

	const best = chooseBestNvimServer(summaries, cwd);
	return { server: best.server, summary: best, candidateCount };
}
