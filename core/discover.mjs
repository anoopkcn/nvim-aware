/**
 * Superseded by core/discovery.mjs. Kept so the hosts keep running until they
 * are rewritten; removed with the last call site.
 */
import { chooseBestNvimServer as choose, createDiscovery, resolveNvimServer } from "./discovery.mjs";

export async function resolveServer(options = {}) {
	return resolveNvimServer({ ...options, probeExplicit: false });
}

export async function collectServerSummaries(options = {}) {
	const { candidates, failures } = await createDiscovery({ transport: options.transport, env: options.env }).discover({
		explicit: options.explicit,
		timeoutMs: options.timeoutMs,
		probeExplicit: true,
	});
	return { summaries: candidates, failures, candidateCount: candidates.length };
}

/** Throwing variant, for the old call sites. */
export function chooseBestNvimServer(items, cwd) {
	const best = choose(items, cwd);
	if (!best) throw new Error("No Neovim server candidates responded");
	return best;
}
