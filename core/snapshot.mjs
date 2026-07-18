/**
 * The snapshot contract: what we ask Neovim for, and what comes back.
 *
 * Requests are built here and evaluated elsewhere — this module never spawns a
 * process. `toSnapshot` is the single point where raw Lua JSON becomes a
 * snapshot, so the shape every renderer depends on is guaranteed in one place
 * rather than assumed at each field access.
 */
import { makeSnapshotLua, SUMMARY_LUA } from "./snapshot-lua.mjs";
import { errorToMessage, runProcess, vimSingleQuoted, DEFAULT_TIMEOUT_MS } from "./proc.mjs";

export const LIMIT_DEFAULTS = Object.freeze({
	surroundingLines: 5,
	maxSelectionBytes: 4000,
	maxBuffers: 30,
	maxQuickfixItems: 30,
});

// Named re-exports for existing call sites.
export const DEFAULT_SURROUNDING_LINES = LIMIT_DEFAULTS.surroundingLines;
export const DEFAULT_MAX_SELECTION_BYTES = LIMIT_DEFAULTS.maxSelectionBytes;
export const DEFAULT_MAX_BUFFERS = LIMIT_DEFAULTS.maxBuffers;
export const DEFAULT_MAX_QUICKFIX_ITEMS = LIMIT_DEFAULTS.maxQuickfixItems;

/**
 * Raw output from Neovim did not match the snapshot contract.
 *
 * Distinct from a connection failure on purpose: re-resolving the server cannot
 * fix contract drift, so callers must not treat this as a reason to rediscover.
 */
export class SnapshotShapeError extends Error {
	constructor(message, { raw } = {}) {
		super(message);
		this.name = "SnapshotShapeError";
		if (raw !== undefined) this.raw = excerpt(raw);
	}
}

function excerpt(text, max = 200) {
	const value = String(text);
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function normalizeLimits(limits = {}) {
	return {
		surroundingLines: Math.max(0, Math.floor(limits.surroundingLines ?? LIMIT_DEFAULTS.surroundingLines)),
		maxSelectionBytes: Math.max(0, Math.floor(limits.maxSelectionBytes ?? LIMIT_DEFAULTS.maxSelectionBytes)),
		maxBuffers: Math.max(1, Math.floor(limits.maxBuffers ?? LIMIT_DEFAULTS.maxBuffers)),
		maxQuickfixItems: Math.max(0, Math.floor(limits.maxQuickfixItems ?? LIMIT_DEFAULTS.maxQuickfixItems)),
	};
}

export function limitsKey(limits) {
	return `${limits.surroundingLines}:${limits.maxSelectionBytes}:${limits.maxBuffers}:${limits.maxQuickfixItems}`;
}

const expressionCache = new Map();

/** @returns {{kind: "snapshot", expression: string}} */
export function snapshotRequest(limits) {
	const normalized = normalizeLimits(limits);
	const key = limitsKey(normalized);
	let expression = expressionCache.get(key);
	if (!expression) {
		expression = `luaeval(${vimSingleQuoted(makeSnapshotLua(normalized))})`;
		expressionCache.set(key, expression);
	}
	return { kind: "snapshot", expression };
}

/** @returns {{kind: "summary", expression: string}} */
export function summaryRequest() {
	return { kind: "summary", expression: `luaeval(${vimSingleQuoted(SUMMARY_LUA)})` };
}

function parseJson(raw, what) {
	if (typeof raw !== "string" || !raw.trim()) {
		throw new SnapshotShapeError(`Neovim returned an empty ${what}`);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new SnapshotShapeError(`Neovim returned unparseable ${what} JSON: ${errorToMessage(error)}`, { raw });
	}
}

/**
 * Neovim encodes an empty Lua table as `[]`, so these arrive as arrays in
 * practice. Coerce anyway: a dict-shaped value here would otherwise reach the
 * renderer as `undefined.length` and read as "nothing to show".
 */
function asArray(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") return Object.values(value);
	return [];
}

function asPosition(value) {
	return { line: Number(value?.line ?? 0), column: Number(value?.column ?? 0) };
}

/**
 * Parse raw Lua JSON into the snapshot every renderer depends on.
 * @throws {SnapshotShapeError} when a required field is missing.
 */
export function toSnapshot(raw, { server }) {
	const parsed = parseJson(raw, "snapshot");

	if (!parsed.currentBuffer || typeof parsed.currentBuffer !== "object") {
		throw new SnapshotShapeError("snapshot is missing currentBuffer", { raw });
	}
	if (!parsed.cursor || typeof parsed.cursor !== "object") {
		throw new SnapshotShapeError("snapshot is missing cursor", { raw });
	}

	const quickfix = parsed.quickfix
		? { ...parsed.quickfix, items: asArray(parsed.quickfix.items), size: Number(parsed.quickfix.size ?? 0) }
		: null;

	return {
		server,
		cwd: parsed.cwd ?? "",
		mode: parsed.mode ?? "",
		currentFile: parsed.currentFile ?? "",
		currentBuffer: parsed.currentBuffer,
		cursor: { ...asPosition(parsed.cursor), lineText: parsed.cursor.lineText ?? "" },
		// Lua drops nil keys entirely, so absence is normal, not a defect.
		selection: parsed.selection ?? null,
		search: parsed.search ?? "",
		quickfix,
		surroundingLines: asArray(parsed.surroundingLines),
		buffers: asArray(parsed.buffers),
		windows: asArray(parsed.windows),
	};
}

export function toSummary(raw, { server }) {
	const parsed = parseJson(raw, "server summary");
	return {
		server,
		cwd: parsed.cwd ?? "",
		currentFile: parsed.currentFile ?? "",
		cursor: asPosition(parsed.cursor),
	};
}

// ---------------------------------------------------------------------------
// Fetching. Superseded by core/session.mjs in the next step; kept so the hosts
// keep running while the seam is introduced.
// ---------------------------------------------------------------------------

const snapshotCache = new Map();
const snapshotInFlight = new Map();

function cacheKey(server, limits) {
	return `${server}\0${limitsKey(limits)}`;
}

async function evaluate(server, request, timeoutMs) {
	const result = await runProcess("nvim", ["--server", server, "--remote-expr", request.expression], { timeoutMs });
	if (result.code !== 0) {
		throw new Error(`nvim --remote-expr failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
	return result.stdout.trim() || result.stderr.trim();
}

export async function getNvimSnapshot(server, options = {}) {
	const limits = normalizeLimits(options);
	const raw = await evaluate(server, snapshotRequest(limits), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return toSnapshot(raw, { server });
}

export async function getNvimServerSummary(server, options = {}) {
	const raw = await evaluate(server, summaryRequest(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return toSummary(raw, { server });
}

export async function getCachedNvimSnapshot(server, options = {}, cacheOptions = {}) {
	const limits = normalizeLimits(options);
	const key = cacheKey(server, limits);
	const ttlMs = cacheOptions.ttlMs ?? 0;
	const cached = snapshotCache.get(key);
	if (!cacheOptions.force && ttlMs > 0 && cached && Date.now() - cached.createdAt <= ttlMs) {
		return cached.snapshot;
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const requestKey = `${key}\0${timeoutMs}`;
	const inFlight = snapshotInFlight.get(requestKey);
	if (inFlight) return inFlight;

	const promise = getNvimSnapshot(server, { ...limits, timeoutMs })
		.then((snapshot) => {
			snapshotCache.set(key, { snapshot, createdAt: Date.now() });
			return snapshot;
		})
		.finally(() => snapshotInFlight.delete(requestKey));
	snapshotInFlight.set(requestKey, promise);
	return promise;
}

export async function getPromptNvimSnapshot(server, { ttlMs, refreshTimeoutMs, options = {} }) {
	const limits = normalizeLimits(options);
	const cached = snapshotCache.get(cacheKey(server, limits));

	if (cached && Date.now() - cached.createdAt <= ttlMs) {
		return { snapshot: cached.snapshot };
	}

	const timeoutMs = cached ? refreshTimeoutMs : DEFAULT_TIMEOUT_MS;
	try {
		return { snapshot: await getCachedNvimSnapshot(server, { ...limits, timeoutMs }, { force: true }) };
	} catch (error) {
		if (cached) return { snapshot: cached.snapshot, warning: errorToMessage(error) };
		throw error;
	}
}
