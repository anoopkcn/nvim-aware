// GENERATED FILE — do not edit. Source: core/config.mjs. Regenerate with `npm run build` (or `node scripts/build.mjs`).
/**
 * Configuration, read from the environment as a value.
 *
 * A value rather than a set of getters so policy can be exercised without
 * mutating process.env, and so a turn sees one consistent reading.
 *
 * Environment variables:
 *   NVIM_AWARE_SERVER             explicit Neovim server address to pin
 *   NVIM_AWARE_PROMPT_CONTEXT     auto | full | hint | off   (default: auto)
 *   NVIM_AWARE_SNAPSHOT_TTL_MS    snapshot cache TTL          (default: 750)
 *   NVIM_AWARE_PROMPT_TIMEOUT_MS  refresh timeout on prompt   (default: 800)
 *   NVIM_AWARE_DISABLE            any truthy value disables injection entirely
 */
import { asNonEmptyString, readEnvMs } from "./proc.mjs";

export const CONFIG_DEFAULTS = Object.freeze({
	promptContextMode: "auto",
	snapshotTtlMs: 750,
	promptTimeoutMs: 800,
});

const VALID_PROMPT_CONTEXT_MODES = new Set(["auto", "full", "hint", "off"]);

/** Falsy spellings that mean "not disabled" rather than "disabled". */
const FALSY = new Set(["0", "false", "no"]);

/**
 * @returns {Readonly<{server: string|undefined, promptContextMode: "auto"|"full"|"hint"|"off",
 *                     snapshotTtlMs: number, promptTimeoutMs: number, disabled: boolean}>}
 */
export function readConfig(env = process.env) {
	const mode = asNonEmptyString(env.NVIM_AWARE_PROMPT_CONTEXT)?.toLowerCase();
	const disable = asNonEmptyString(env.NVIM_AWARE_DISABLE)?.toLowerCase();

	return Object.freeze({
		server: asNonEmptyString(env.NVIM_AWARE_SERVER),
		promptContextMode: mode && VALID_PROMPT_CONTEXT_MODES.has(mode) ? mode : CONFIG_DEFAULTS.promptContextMode,
		snapshotTtlMs: readEnvMs(env, "NVIM_AWARE_SNAPSHOT_TTL_MS", CONFIG_DEFAULTS.snapshotTtlMs),
		promptTimeoutMs: readEnvMs(env, "NVIM_AWARE_PROMPT_TIMEOUT_MS", CONFIG_DEFAULTS.promptTimeoutMs),
		disabled: disable !== undefined && !FALSY.has(disable),
	});
}
