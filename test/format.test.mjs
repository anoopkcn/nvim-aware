import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSnapshot } from "../core/format.mjs";

/** Minimal snapshot with every required key, for tests that vary one thing. */
function snapshotFixture(overrides = {}) {
	return {
		server: "/tmp/nvim-test",
		cwd: "/home/dev/project",
		mode: "n",
		currentFile: "/home/dev/project/src/main.js",
		currentBuffer: { bufnr: 1, name: "/home/dev/project/src/main.js", filetype: "javascript", modified: false, lineCount: 40, listed: true, visible: true },
		cursor: { line: 12, column: 3, lineText: "const x = 1;" },
		surroundingLines: [{ line: 12, text: "const x = 1;", current: true }],
		selection: null,
		search: "",
		quickfix: null,
		buffers: [],
		windows: [],
		...overrides,
	};
}

test("compact omits surrounding lines and windows; full includes them", () => {
	const snapshot = snapshotFixture({
		windows: [{ winid: 1000, bufnr: 1, file: "/home/dev/project/src/main.js", cursor: { line: 12, column: 3 } }],
	});

	const compact = formatSnapshot(snapshot, { compact: true }).join("\n");
	assert.ok(!compact.includes("Lines around cursor"));
	assert.ok(!compact.includes("Visible windows"));

	const full = formatSnapshot(snapshot, { compact: false }).join("\n");
	assert.ok(full.includes("Lines around cursor"));
	assert.ok(full.includes("Visible windows"));
});

test("compact keeps only visible or modified buffers", () => {
	const snapshot = snapshotFixture({
		buffers: [
			{ bufnr: 1, name: "/p/visible.js", filetype: "javascript", modified: false, lineCount: 1, listed: true, visible: true },
			{ bufnr: 2, name: "/p/modified.js", filetype: "javascript", modified: true, lineCount: 1, listed: true, visible: false },
			{ bufnr: 3, name: "/p/background.js", filetype: "javascript", modified: false, lineCount: 1, listed: true, visible: false },
		],
	});

	const compact = formatSnapshot(snapshot, { compact: true }).join("\n");
	assert.ok(compact.includes("visible.js"));
	assert.ok(compact.includes("modified.js"));
	assert.ok(!compact.includes("background.js"));
	assert.ok(compact.includes("1 more buffer(s)"));

	const full = formatSnapshot(snapshot, { compact: false }).join("\n");
	assert.ok(full.includes("background.js"));
});

test("renders the cursor position and current file", () => {
	const lines = formatSnapshot(snapshotFixture(), { compact: true });
	assert.ok(lines.includes("- Cursor: line 12, column 3"));
	assert.ok(lines.some((line) => line.startsWith("- Current file: /home/dev/project/src/main.js ft=javascript")));
});
