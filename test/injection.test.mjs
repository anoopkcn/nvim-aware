import assert from "node:assert/strict";
import { test } from "node:test";
import { promptLikelyNeedsNvimContext } from "../core/config.mjs";

// Expanded into a full characterization table in S4, before the heuristic is
// widened. These are the cases that must never regress.
test("matches prompts that reference editor state", () => {
	for (const prompt of [
		"explain this file",
		"fix the selected code",
		"what does the error under the cursor mean?",
		"work through the quickfix list",
		"what is in my open buffers?",
	]) {
		assert.equal(promptLikelyNeedsNvimContext(prompt), true, prompt);
	}
});

test("ignores prompts with no editor reference", () => {
	for (const prompt of ["what is 2 + 2", "write a haiku about cats", ""]) {
		assert.equal(promptLikelyNeedsNvimContext(prompt), false, prompt);
	}
});

test("tolerates non-string input", () => {
	assert.equal(promptLikelyNeedsNvimContext(undefined), false);
	assert.equal(promptLikelyNeedsNvimContext(null), false);
});
