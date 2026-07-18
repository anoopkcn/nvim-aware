import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../core/config.mjs";
import { decideInjection, decideSessionInjection, promptLikelyNeedsNvimContext } from "../core/injection.mjs";

const config = (env = {}) => readConfig(env);

// ---------------------------------------------------------------------------
// The decision table, exhaustively. This is the rule both hosts now obey.
// ---------------------------------------------------------------------------

const MATCHING = "explain this file";
const NEUTRAL = "what is 2 + 2";

test("disabled beats every mode", () => {
	for (const mode of ["auto", "full", "hint", "off"]) {
		for (const prompt of [MATCHING, NEUTRAL]) {
			const c = config({ NVIM_AWARE_DISABLE: "1", NVIM_AWARE_PROMPT_CONTEXT: mode });
			assert.equal(decideInjection({ prompt, config: c }).kind, "none", `${mode} / ${prompt}`);
			assert.equal(decideSessionInjection({ config: c }).kind, "none", mode);
		}
	}
});

test("per-turn decisions across all modes", () => {
	const cases = [
		["off", MATCHING, "none"],
		["off", NEUTRAL, "none"],
		["hint", MATCHING, "hint"],
		["hint", NEUTRAL, "hint"],
		["full", MATCHING, "snapshot"],
		["full", NEUTRAL, "snapshot"],
		["auto", MATCHING, "snapshot"],
		["auto", NEUTRAL, "none"],
	];
	for (const [mode, prompt, expected] of cases) {
		const c = config({ NVIM_AWARE_PROMPT_CONTEXT: mode });
		assert.equal(decideInjection({ prompt, config: c }).kind, expected, `${mode} / ${prompt}`);
	}
});

test("session-start decisions across all modes", () => {
	const cases = [["off", "none"], ["hint", "hint"], ["auto", "hint"], ["full", "snapshot"]];
	for (const [mode, expected] of cases) {
		assert.equal(decideSessionInjection({ config: config({ NVIM_AWARE_PROMPT_CONTEXT: mode }) }).kind, expected, mode);
	}
});

test("auto is the default, and an unknown mode falls back to it", () => {
	assert.equal(decideInjection({ prompt: NEUTRAL, config: config({}) }).kind, "none");
	assert.equal(decideInjection({ prompt: MATCHING, config: config({}) }).kind, "snapshot");
	const bogus = config({ NVIM_AWARE_PROMPT_CONTEXT: "sometimes" });
	assert.equal(bogus.promptContextMode, "auto");
});

// ---------------------------------------------------------------------------
// The heuristic. These cases decide what `auto` costs, so they are recorded
// explicitly -- including the deliberate misses.
// ---------------------------------------------------------------------------

test("matches structural references to the editor", () => {
	for (const prompt of [
		"explain this file",
		"fix the selected code",
		"what does the error under the cursor mean?",
		"go through the quickfix list",
		"what is in my open buffers?",
		"what is the current file",
		"refactor this function",
		"rename this variable",
		"add a docstring to this method",
		"explain the highlighted section",
		"jump to the next error",
		"show me the diagnostics",
		"is nvim connected?",
		"run these tests",
		"check the current directory",
		"what files are open",
		"which buffer am I in",
		"where am I",
		"what am I looking at",
		"clean up these imports",
	]) {
		assert.equal(promptLikelyNeedsNvimContext(prompt), true, prompt);
	}
});

test("ignores prompts with no editor reference", () => {
	for (const prompt of [
		"what is 2 + 2",
		"write a haiku about cats",
		"what is the capital of France",
		"commit my changes",
		"run the tests",
		"",
	]) {
		assert.equal(promptLikelyNeedsNvimContext(prompt), false, prompt);
	}
});

test("bare demonstratives stay unmatched, on purpose", () => {
	// "this" refers to earlier conversation at least as often as to the buffer.
	// Matching it would inject on nearly every turn, which is the cost `auto`
	// exists to avoid. A noun has to follow.
	for (const prompt of ["summarize this", "what does this do", "fix it", "explain that"]) {
		assert.equal(promptLikelyNeedsNvimContext(prompt), false, prompt);
	}
});

test("tolerates non-string input", () => {
	assert.equal(promptLikelyNeedsNvimContext(undefined), false);
	assert.equal(promptLikelyNeedsNvimContext(null), false);
	assert.equal(promptLikelyNeedsNvimContext(42), false);
});
