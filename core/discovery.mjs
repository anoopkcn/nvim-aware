/**
 * Which Neovim instance are we talking to?
 *
 * Candidate sources, in order:
 *   explicit address  ->  $NVIM  ->  $NVIM_LISTEN_ADDRESS  ->  serverlist()
 *   ->  (fallback) socket-file scan of $XDG_RUNTIME_DIR / $TMPDIR / /tmp
 *
 * Returns data, never output. Two callers used to answer this question with
 * different rules and only one of them could report anything: the launcher
 * probed and printed, the hosts trusted and stayed silent. `probeExplicit`
 * is now the single knob between them, and the printing lives with the caller
 * that knows whether printing is wanted.
 */
import { isInside, mapWithConcurrency } from "./proc.mjs";
import { errorToMessage } from "./proc.mjs";
import { summaryRequest, toSummary } from "./snapshot.mjs";
import { createSpawnTransport } from "./transport.mjs";

const PROBE_CONCURRENCY = 4;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;

/**
 * @typedef {{server: string, source: "explicit"|"env"|"serverlist"|"scan", probed: boolean,
 *            cwd?: string, currentFile?: string, cursor?: {line: number, column: number}}} ServerCandidate
 * @typedef {{candidates: ServerCandidate[], failures: string[], best: ServerCandidate|null,
 *            source: "explicit"|"env"|"serverlist"|"scan"|"none"}} Discovery
 */

/**
 * Pick the candidate most relevant to `cwd`: exact cwd, then a file inside it,
 * then an instance whose cwd contains it. Total — an empty list yields
 * undefined rather than throwing, so callers can decide what absence means.
 * @returns {ServerCandidate | undefined}
 */
export function chooseBestNvimServer(candidates, cwd) {
	return (
		candidates.find((item) => item.cwd === cwd) ??
		candidates.find((item) => isInside(cwd, item.currentFile)) ??
		candidates.find((item) => isInside(item.cwd, cwd)) ??
		candidates[0]
	);
}

/** The message a host shows when discovery came back empty. */
export function describeDiscoveryFailure({ failures }) {
	if (failures.length > 0) {
		return `Found Neovim server candidates, but none responded. ${failures.join("; ")}`;
	}
	return "No Neovim server found. Start Neovim normally, or run `nvim --listen /tmp/nvim-main` and set NVIM_AWARE_SERVER=/tmp/nvim-main.";
}

export function createDiscovery({ transport = createSpawnTransport(), env = process.env } = {}) {
	function tagged(entries) {
		const seen = new Set();
		const list = [];
		for (const [server, source] of entries) {
			const address = server?.trim();
			if (!address || seen.has(address)) continue;
			seen.add(address);
			list.push({ server: address, source });
		}
		return list;
	}

	async function probe(candidates, timeoutMs) {
		return mapWithConcurrency(candidates, PROBE_CONCURRENCY, async (candidate) => {
			try {
				const raw = await transport.evaluate(candidate.server, summaryRequest(), { timeoutMs });
				return { ok: { ...candidate, ...toSummary(raw, { server: candidate.server }), probed: true } };
			} catch (error) {
				return { failure: `${candidate.server}: ${errorToMessage(error)}` };
			}
		});
	}

	/**
	 * @param {{explicit?: string, cwd?: string, timeoutMs?: number, probeExplicit?: boolean}} options
	 * @returns {Promise<Discovery>}
	 */
	async function discover({ explicit, cwd = process.cwd(), timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, probeExplicit = true } = {}) {
		// Trusting an explicit address costs nothing: the follow-up snapshot
		// surfaces a bad address with the same error handling a probe would.
		if (explicit && !probeExplicit) {
			const candidate = { server: explicit, source: "explicit", probed: false };
			return { candidates: [candidate], failures: [], best: candidate, source: "explicit" };
		}

		const fast = explicit
			? tagged([[explicit, "explicit"]])
			: tagged([
					[env.NVIM, "env"],
					[env.NVIM_LISTEN_ADDRESS, "env"],
					...(await transport.listServers()).map((server) => [server, "serverlist"]),
				]);

		let results = fast.length > 0 ? await probe(fast, timeoutMs) : [];
		let candidates = results.flatMap((r) => (r.ok ? [r.ok] : []));

		// Socket scanning is slow; only reach for it when nothing else answered.
		if (!explicit && candidates.length === 0) {
			const known = new Set(fast.map((c) => c.server));
			const scanned = tagged((await transport.scanSocketFiles()).filter((s) => !known.has(s)).map((s) => [s, "scan"]));
			if (scanned.length > 0) {
				results = [...results, ...(await probe(scanned, timeoutMs))];
				candidates = results.flatMap((r) => (r.ok ? [r.ok] : []));
			}
		}

		const failures = results.flatMap((r) => (r.failure ? [r.failure] : []));
		const best = chooseBestNvimServer(candidates, cwd);
		return { candidates, failures, best: best ?? null, source: best?.source ?? "none" };
	}

	return { discover };
}

/**
 * Resolve one address for a cwd, throwing a descriptive error when nothing
 * answers. The convenience hosts and sessions want; the launcher uses
 * `discover` directly because it needs every candidate.
 */
export async function resolveNvimServer(options = {}) {
	const discovery = options.discovery ?? createDiscovery({ transport: options.transport, env: options.env });
	const result = await discovery.discover({
		explicit: options.explicit,
		cwd: options.cwd,
		timeoutMs: options.timeoutMs,
		probeExplicit: options.probeExplicit ?? false,
	});

	if (!result.best) throw new Error(describeDiscoveryFailure(result));
	return { server: result.best.server, summary: result.best, candidateCount: result.candidates.length, source: result.source };
}
