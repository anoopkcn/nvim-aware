import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMIT_DEFAULTS, normalizeLimits, SnapshotShapeError, snapshotRequest, summaryRequest, toSnapshot, toSummary } from "../core/snapshot.mjs";

/** Raw Lua JSON, shaped exactly as `fn.json_encode` emits it. */
const RAW_BASIC = JSON.stringify({
	cwd: "/home/dev/project",
	mode: "n",
	currentFile: "/home/dev/project/src/main.js",
	currentBuffer: { bufnr: 1, name: "/home/dev/project/src/main.js", filetype: "javascript", modified: true, lineCount: 40, listed: true, visible: true },
	cursor: { line: 12, column: 3, lineText: "const x = 1;" },
	surroundingLines: [{ line: 12, text: "const x = 1;", current: true }],
	search: "TODO",
	buffers: [{ bufnr: 1, name: "/home/dev/project/src/main.js", filetype: "javascript", modified: true, lineCount: 40, listed: true, visible: true }],
	windows: [{ winid: 1000, bufnr: 1, file: "/home/dev/project/src/main.js", cursor: { line: 12, column: 3 } }],
	// `selection` and `quickfix` are absent: Lua drops nil keys entirely.
});

test("attaches the server and preserves the contract fields", () => {
	const snapshot = toSnapshot(RAW_BASIC, { server: "/tmp/nvim-a" });
	assert.equal(snapshot.server, "/tmp/nvim-a");
	assert.equal(snapshot.cwd, "/home/dev/project");
	assert.equal(snapshot.cursor.line, 12);
	assert.equal(snapshot.cursor.lineText, "const x = 1;");
	assert.equal(snapshot.currentBuffer.modified, true);
	assert.equal(snapshot.search, "TODO");
});

test("absent selection and quickfix normalize to null, not undefined", () => {
	const snapshot = toSnapshot(RAW_BASIC, { server: "/tmp/nvim-a" });
	assert.equal(snapshot.selection, null);
	assert.equal(snapshot.quickfix, null);
});

test("coerces dict-shaped collections to arrays", () => {
	// Defensive: Neovim emits `[]` for empty tables, but a dict here would
	// otherwise reach the renderer as `undefined.length` and render nothing.
	const raw = JSON.stringify({
		...JSON.parse(RAW_BASIC),
		surroundingLines: {},
		buffers: {},
		windows: {},
	});
	const snapshot = toSnapshot(raw, { server: "/tmp/nvim-a" });
	assert.deepEqual(snapshot.surroundingLines, []);
	assert.deepEqual(snapshot.buffers, []);
	assert.deepEqual(snapshot.windows, []);
});

test("normalizes quickfix items to an array", () => {
	const raw = JSON.stringify({ ...JSON.parse(RAW_BASIC), quickfix: { title: "make", currentIndex: 0, size: 0, items: {}, truncated: false } });
	assert.deepEqual(toSnapshot(raw, { server: "/tmp/a" }).quickfix.items, []);
});

test("missing currentBuffer is a shape error, not a TypeError downstream", () => {
	const raw = JSON.stringify({ ...JSON.parse(RAW_BASIC), currentBuffer: undefined });
	assert.throws(() => toSnapshot(raw, { server: "/tmp/a" }), SnapshotShapeError);
});

test("missing cursor is a shape error", () => {
	const raw = JSON.stringify({ ...JSON.parse(RAW_BASIC), cursor: undefined });
	assert.throws(() => toSnapshot(raw, { server: "/tmp/a" }), SnapshotShapeError);
});

test("unparseable output carries a truncated excerpt", () => {
	try {
		toSnapshot("E5108: Error executing lua ...", { server: "/tmp/a" });
		assert.fail("expected a SnapshotShapeError");
	} catch (error) {
		assert.ok(error instanceof SnapshotShapeError);
		assert.match(error.raw, /E5108/);
	}
});

test("empty output is a shape error", () => {
	assert.throws(() => toSnapshot("", { server: "/tmp/a" }), SnapshotShapeError);
	assert.throws(() => toSnapshot("   ", { server: "/tmp/a" }), SnapshotShapeError);
});

test("toSummary fills absent fields", () => {
	const summary = toSummary(JSON.stringify({ cwd: "/p" }), { server: "/tmp/a" });
	assert.deepEqual(summary, { server: "/tmp/a", cwd: "/p", currentFile: "", cursor: { line: 0, column: 0 } });
});

test("normalizeLimits clamps and defaults", () => {
	assert.deepEqual(normalizeLimits({}), { ...LIMIT_DEFAULTS });
	assert.equal(normalizeLimits({ surroundingLines: -5 }).surroundingLines, 0);
	assert.equal(normalizeLimits({ maxBuffers: 0 }).maxBuffers, 1);
	assert.equal(normalizeLimits({ maxSelectionBytes: 10.7 }).maxSelectionBytes, 10);
});

test("requests are tagged and carry a luaeval expression", () => {
	const snapshot = snapshotRequest({});
	assert.equal(snapshot.kind, "snapshot");
	assert.match(snapshot.expression, /^luaeval\('/);
	assert.equal(summaryRequest().kind, "summary");
});

test("limits reach the Lua", () => {
	assert.match(snapshotRequest({ maxBuffers: 7 }).expression, /local max_buffers = 7/);
});

test("quickfix is queried with idx=0", () => {
	// getqflist({idx: N, items: 1}) returns ONLY the entry at N. Asking with
	// idx=1 silently reduced every quickfix list to a single item; idx=0
	// reports the current index and returns the whole list.
	assert.match(snapshotRequest({}).expression, /getqflist, \{ title = 1, idx = 0, size = 1, items = 1 \}/);
});
