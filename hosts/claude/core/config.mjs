// GENERATED FILE — do not edit. Source: core/config.mjs. Regenerate with `npm run build` (or `node scripts/build.mjs`).
/**
 * Configuration + prompt heuristics.
 *
 * Environment variables:
 *   NVIM_AWARE_SERVER             explicit Neovim server address to pin
 *   NVIM_AWARE_PROMPT_CONTEXT     auto | full | hint | off   (default: auto)
 *   NVIM_AWARE_SNAPSHOT_TTL_MS    snapshot cache TTL          (default: 750)
 *   NVIM_AWARE_PROMPT_TIMEOUT_MS  refresh timeout on prompt   (default: 800)
 *   NVIM_AWARE_DISABLE            any truthy value disables injection entirely
 */
import { asNonEmptyString, readEnvMs } from "./proc.mjs";

const DEFAULT_PROMPT_CONTEXT_MODE = "auto";
const VALID_PROMPT_CONTEXT_MODES = new Set(["auto", "full", "hint", "off"]);

/** Resolve the prompt-context mode from the environment. */
export function getPromptContextMode() {
	const value = asNonEmptyString(process.env.NVIM_AWARE_PROMPT_CONTEXT)?.toLowerCase() ?? DEFAULT_PROMPT_CONTEXT_MODE;
	return VALID_PROMPT_CONTEXT_MODES.has(value) ? value : DEFAULT_PROMPT_CONTEXT_MODE;
}

/** The explicit server address, if pinned via env. */
export function getExplicitServer() {
	return asNonEmptyString(process.env.NVIM_AWARE_SERVER);
}

/** Snapshot cache TTL for long-lived hosts. */
export function getSnapshotTtlMs() {
	return readEnvMs("NVIM_AWARE_SNAPSHOT_TTL_MS", 750);
}

/** Refresh timeout for prompt-time snapshots. */
export function getPromptRefreshTimeoutMs() {
	return readEnvMs("NVIM_AWARE_PROMPT_TIMEOUT_MS", 800);
}

/** Master kill switch for context injection. */
export function isDisabled() {
	const value = asNonEmptyString(process.env.NVIM_AWARE_DISABLE)?.toLowerCase();
	return value !== undefined && value !== "0" && value !== "false" && value !== "no";
}

/**
 * Decide whether a user's prompt looks like it depends on live editor state.
 */
export function promptLikelyNeedsNvimContext(prompt) {
	const text = String(prompt ?? "").toLowerCase();
	return [
		/\b(neovim|nvim)\b/,
		/\b(current|open|active)\s+(file|buffer|window|tab)\b/,
		/\b(this|that|these|those)\s+(files?|buffers?|code|functions?|class(?:es)?|methods?|selections?|snippets?|lines?)\b/,
		/\b(selected|selection|visual selection|highlighted)\b/,
		/\b(cursor|under cursor|around here|right here|line under|current line)\b/,
		/\b(quickfix|qflist|quickfix list|diagnostics?|errors?|warnings?|lint|linter|compiler|build failure)\b/,
		/\b(search register|last search|open buffers?|listed buffers?|visible windows?)\b/,
	].some((pattern) => pattern.test(text));
}
