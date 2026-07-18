// GENERATED FILE — do not edit. Source: core/session.mjs. Regenerate with `npm run build` (or `node scripts/build.mjs`).
/**
 * A connection to one Neovim instance.
 *
 * Every host used to assemble this itself — resolve a server, remember it,
 * fetch a snapshot, decide when to give up on the remembered address — and the
 * assemblies drifted: five different timeouts, and two different rules for what
 * happens after a failure. This is that assembly, once.
 *
 * What sits behind the seam: lazy server resolution shared by concurrent
 * callers, invalidate-on-failure with a backoff, TTL caching, in-flight
 * de-duplication, stale fallback, and a bounded cache.
 */
import { errorToMessage } from "./proc.mjs";
import { resolveNvimServer } from "./discovery.mjs";
import { limitsKey, normalizeLimits, snapshotRequest, SnapshotShapeError, toSnapshot } from "./snapshot.mjs";
import { createSpawnTransport } from "./transport.mjs";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_REDISCOVER_BACKOFF_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 8;

/**
 * @param {object} options
 * @param {import("./transport.mjs").NvimTransport} [options.transport]
 * @param {(input: {cwd: string, explicit?: string}) => Promise<{server: string, candidateCount?: number}>} [options.resolve]
 * @param {string} [options.explicitServer]  pinned address; skips discovery
 * @param {string | (() => string)} [options.cwd]
 * @param {number} [options.defaultTimeoutMs]
 * @param {number} [options.ttlMs]           0 means never serve from cache
 * @param {number} [options.staleTimeoutMs]  refresh budget when a stale entry exists to fall back to
 * @param {number} [options.maxCacheEntries]
 * @param {number} [options.rediscoverBackoffMs]
 * @param {() => number} [options.now]
 */
export function createNvimSession({
	transport = createSpawnTransport(),
	resolve,
	explicitServer,
	cwd = () => process.cwd(),
	defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
	ttlMs = 0,
	staleTimeoutMs,
	maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
	rediscoverBackoffMs = DEFAULT_REDISCOVER_BACKOFF_MS,
	now = Date.now,
} = {}) {
	const resolveConnection = resolve ?? ((input) => resolveNvimServer({ ...input, transport }));
	const currentCwd = () => (typeof cwd === "function" ? cwd() : cwd);

	/** @type {Promise<{server: string, candidateCount: number}> | null} */
	let connectionPromise = null;
	/** Set after a failure; suppresses rediscovery until the clock passes it. */
	let backoffUntil = 0;
	let lastError;

	/** @type {Map<string, {snapshot: object, createdAt: number}>} */
	const cache = new Map();
	/** @type {Map<string, Promise<object>>} */
	const inFlight = new Map();

	function connection() {
		if (connectionPromise) return connectionPromise;

		// Without this, a long-lived session with Neovim closed pays a full
		// discovery -- including the socket scan -- on every single turn.
		if (lastError && now() < backoffUntil) return Promise.reject(lastError);

		connectionPromise = Promise.resolve()
			.then(() => resolveConnection({ cwd: currentCwd(), explicit: explicitServer }))
			.then((resolved) => {
				lastError = undefined;
				return { server: resolved.server, candidateCount: resolved.candidateCount ?? 1 };
			})
			.catch((error) => {
				connectionPromise = null;
				noteFailure(error);
				throw error;
			});

		return connectionPromise;
	}

	/**
	 * A shape error means Neovim answered but the contract drifted; rediscovering
	 * cannot fix that, so only connection-shaped failures drop the address.
	 */
	function noteFailure(error) {
		lastError = error;
		backoffUntil = now() + rediscoverBackoffMs;
	}

	function remember(key, snapshot) {
		cache.delete(key);
		cache.set(key, { snapshot, createdAt: now() });
		while (cache.size > maxCacheEntries) {
			cache.delete(cache.keys().next().value);
		}
	}

	function cached(key) {
		const entry = cache.get(key);
		if (!entry) return undefined;
		// Refresh recency so the bounded cache evicts by use, not by age.
		cache.delete(key);
		cache.set(key, entry);
		return entry;
	}

	async function fetchSnapshot(server, limits, timeoutMs) {
		const raw = await transport.evaluate(server, snapshotRequest(limits), { timeoutMs });
		return toSnapshot(raw, { server });
	}

	async function snapshot({ limits, timeoutMs, force = false } = {}) {
		const normalized = normalizeLimits(limits);
		const { server } = await connection();
		const key = `${server}\0${limitsKey(normalized)}`;

		const entry = cached(key);
		if (!force && ttlMs > 0 && entry && now() - entry.createdAt <= ttlMs) {
			return entry.snapshot;
		}

		// Keyed without the timeout: two callers wanting the same snapshot should
		// share one round-trip. The first caller's timeout wins.
		const pending = inFlight.get(key);
		if (pending) return pending;

		const promise = fetchSnapshot(server, normalized, timeoutMs ?? defaultTimeoutMs)
			.then((result) => {
				remember(key, result);
				return result;
			})
			.catch((error) => {
				if (!(error instanceof SnapshotShapeError)) {
					connectionPromise = null;
					noteFailure(error);
				}
				throw error;
			})
			.finally(() => inFlight.delete(key));

		inFlight.set(key, promise);
		return promise;
	}

	/**
	 * Prompt-time fetch: serve from cache within the TTL, otherwise refresh and
	 * fall back to the last known snapshot when Neovim is briefly slow or gone.
	 * The short refresh budget applies only when there is something to fall back to.
	 */
	async function snapshotOrStale({ limits, timeoutMs } = {}) {
		const normalized = normalizeLimits(limits);
		let entry;
		try {
			const { server } = await connection();
			entry = cached(`${server}\0${limitsKey(normalized)}`);
		} catch {
			// No connection yet; the fetch below reports the real failure.
		}

		if (entry && ttlMs > 0 && now() - entry.createdAt <= ttlMs) {
			return { snapshot: entry.snapshot, stale: false };
		}

		const budget = timeoutMs ?? (entry ? (staleTimeoutMs ?? defaultTimeoutMs) : defaultTimeoutMs);
		try {
			return { snapshot: await snapshot({ limits: normalized, timeoutMs: budget, force: true }), stale: false };
		} catch (error) {
			if (entry) return { snapshot: entry.snapshot, stale: true, warning: errorToMessage(error) };
			throw error;
		}
	}

	return {
		connection,
		async server() {
			return (await connection()).server;
		},
		snapshot,
		snapshotOrStale,
		invalidate({ server = true, cache: clearCache = true } = {}) {
			if (server) {
				connectionPromise = null;
				lastError = undefined;
				backoffUntil = 0;
			}
			if (clearCache) cache.clear();
		},
		stats() {
			return { cacheSize: cache.size, inFlight: inFlight.size, backoffUntil };
		},
	};
}
