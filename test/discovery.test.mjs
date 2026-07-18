import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseBestNvimServer } from "../core/discover.mjs";

// `isInside` is pure path.relative, so these synthetic paths need not exist.
// Precedence cases are completed in S5, when the function becomes total.
const exact = { server: "/tmp/a", cwd: "/home/dev/project", currentFile: "" };
const byFile = { server: "/tmp/b", cwd: "/elsewhere", currentFile: "/home/dev/project/src/main.js" };
const byDir = { server: "/tmp/c", cwd: "/home/dev", currentFile: "" };
const unrelated = { server: "/tmp/d", cwd: "/var/tmp", currentFile: "" };

test("exact cwd match wins", () => {
	assert.equal(chooseBestNvimServer([unrelated, byDir, byFile, exact], "/home/dev/project").server, "/tmp/a");
});

test("file containment beats directory containment", () => {
	assert.equal(chooseBestNvimServer([unrelated, byDir, byFile], "/home/dev/project").server, "/tmp/b");
});

test("falls back to the first candidate when nothing matches", () => {
	assert.equal(chooseBestNvimServer([unrelated], "/home/dev/project").server, "/tmp/d");
});
