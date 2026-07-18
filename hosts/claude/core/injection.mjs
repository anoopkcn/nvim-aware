// GENERATED FILE — do not edit. Source: core/injection.mjs. Regenerate with `npm run build` (or `node scripts/build.mjs`).
/**
 * Whether a turn gets live editor state, and how much.
 *
 * Both hosts ask this module rather than assembling the rule themselves. It was
 * previously inline in the Claude hook and absent from Pi entirely, which is why
 * NVIM_AWARE_DISABLE and NVIM_AWARE_PROMPT_CONTEXT did nothing under Pi despite
 * being documented as shared.
 *
 * @typedef {{kind: "none" | "hint" | "snapshot"}} InjectionDecision
 */

const NONE = Object.freeze({ kind: "none" });
const HINT = Object.freeze({ kind: "hint" });
const SNAPSHOT = Object.freeze({ kind: "snapshot" });

/**
 * Prompts that plausibly depend on live editor state.
 *
 * The bar is a *structural* reference to the editor — a demonstrative followed
 * by a code noun, a named editor concept, a locational question. Bare "this"
 * and "that" are deliberately excluded: they refer to earlier conversation at
 * least as often as to the buffer, and matching them would inject on nearly
 * every turn, which is the cost `auto` mode exists to avoid.
 */
const PROMPT_PATTERNS = [
	// The editor by name.
	/\b(neovim|nvim)\b/,
	// "the current file", "the open buffer", "the active window".
	/\b(current|open|active|focused)\s+(file|buffer|window|tab|split|pane|line|selection|directory|folder|project|repo|repository)\b/,
	// A demonstrative plus something that lives in a buffer.
	/\b(this|that|these|those)\s+(files?|buffers?|code|functions?|class(?:es)?|methods?|selections?|snippets?|lines?|variables?|symbols?|tests?|blocks?|statements?|types?|imports?|sections?|errors?)\b/,
	// The visual selection.
	/\b(selected|selection|visual selection|highlighted)\b/,
	// The cursor.
	/\b(cursor|under cursor|around here|right here|line under|current line)\b/,
	// Quickfix and diagnostics.
	/\b(quickfix|qflist|quickfix list|diagnostics?|errors?|warnings?|lint|linter|compiler|build failure)\b/,
	// Registers, buffer lists, window layout.
	/\b(search register|last search|open buffers?|listed buffers?|visible windows?)\b/,
	// "what files are open", "which buffer am I in".
	/\b(files?|buffers?|windows?|tabs?)\s+(are|is)\s+open\b/,
	/\bwhich\s+(file|buffer|window|tab)\b/,
	// Locational questions about the editing position.
	/\bwhere\s+am\s+i\b/,
	/\bwhat\s+am\s+i\s+(looking at|editing|viewing|working on)\b/,
];

/** Does this prompt look like it depends on live editor state? */
export function promptLikelyNeedsNvimContext(prompt) {
	const text = String(prompt ?? "").toLowerCase();
	return PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Per-turn decision.
 * @returns {InjectionDecision}
 */
export function decideInjection({ prompt, config }) {
	if (config.disabled) return NONE;

	switch (config.promptContextMode) {
		case "off":
			return NONE;
		case "hint":
			return HINT;
		case "full":
			return SNAPSHOT;
		default:
			// auto: spend tokens only when the prompt reaches for the editor.
			return promptLikelyNeedsNvimContext(prompt) ? SNAPSHOT : NONE;
	}
}

/**
 * Session-start decision. No prompt exists yet, so `auto` announces the tool
 * rather than guessing.
 * @returns {InjectionDecision}
 */
export function decideSessionInjection({ config }) {
	if (config.disabled) return NONE;

	switch (config.promptContextMode) {
		case "off":
			return NONE;
		case "full":
			return SNAPSHOT;
		default:
			return HINT;
	}
}
