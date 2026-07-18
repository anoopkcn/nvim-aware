import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_DEFAULTS, readConfig } from "../core/config.mjs";

test("an empty environment yields the documented defaults", () => {
	const config = readConfig({});
	assert.equal(config.promptContextMode, CONFIG_DEFAULTS.promptContextMode);
	assert.equal(config.snapshotTtlMs, 750);
	assert.equal(config.promptTimeoutMs, 800);
	assert.equal(config.disabled, false);
	assert.equal(config.server, undefined);
});

test("modes are case-insensitive; unknown modes fall back to auto", () => {
	assert.equal(readConfig({ NVIM_AWARE_PROMPT_CONTEXT: "FULL" }).promptContextMode, "full");
	assert.equal(readConfig({ NVIM_AWARE_PROMPT_CONTEXT: " hint " }).promptContextMode, "hint");
	assert.equal(readConfig({ NVIM_AWARE_PROMPT_CONTEXT: "loud" }).promptContextMode, "auto");
	assert.equal(readConfig({ NVIM_AWARE_PROMPT_CONTEXT: "" }).promptContextMode, "auto");
});

test("the kill switch treats explicit falsy spellings as not-disabled", () => {
	for (const value of ["1", "true", "yes", "on", "anything"]) {
		assert.equal(readConfig({ NVIM_AWARE_DISABLE: value }).disabled, true, value);
	}
	for (const value of ["0", "false", "no", "FALSE"]) {
		assert.equal(readConfig({ NVIM_AWARE_DISABLE: value }).disabled, false, value);
	}
	assert.equal(readConfig({}).disabled, false);
});

test("millisecond values reject invalid and negative input", () => {
	assert.equal(readConfig({ NVIM_AWARE_SNAPSHOT_TTL_MS: "1500" }).snapshotTtlMs, 1500);
	assert.equal(readConfig({ NVIM_AWARE_SNAPSHOT_TTL_MS: "-5" }).snapshotTtlMs, 750);
	assert.equal(readConfig({ NVIM_AWARE_SNAPSHOT_TTL_MS: "soon" }).snapshotTtlMs, 750);
	assert.equal(readConfig({ NVIM_AWARE_SNAPSHOT_TTL_MS: "" }).snapshotTtlMs, 750);
	// Zero is honoured, not treated as unset: it turns cache serving off.
	assert.equal(readConfig({ NVIM_AWARE_SNAPSHOT_TTL_MS: "0" }).snapshotTtlMs, 0);
});

test("the server address is trimmed and empty means unset", () => {
	assert.equal(readConfig({ NVIM_AWARE_SERVER: "  /tmp/nvim-main  " }).server, "/tmp/nvim-main");
	assert.equal(readConfig({ NVIM_AWARE_SERVER: "   " }).server, undefined);
});

test("the config is frozen", () => {
	assert.throws(() => {
		readConfig({}).promptContextMode = "full";
	}, TypeError);
});
