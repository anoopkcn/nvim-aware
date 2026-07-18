/**
 * The test-side adapter at the transport seam.
 *
 * `responses` maps a server address to either a `{snapshot, summary}` object or
 * a function `(request, callNumber) => value`. The function form is what makes
 * failure paths testable: it can succeed, then throw, then succeed again.
 * Returning or throwing an Error rejects the call.
 */
export function createFakeTransport({ responses = {}, list = [], sockets = [] } = {}) {
	const calls = [];
	return {
		calls,
		async evaluate(server, request, options = {}) {
			calls.push({ server, kind: request.kind, timeoutMs: options.timeoutMs });
			const entry = responses[server];
			if (!entry) throw new Error(`nvim --remote-expr failed: connection refused (${server})`);
			const value = typeof entry === "function" ? entry(request, calls.length) : entry[request.kind];
			if (value instanceof Error) throw value;
			if (value === undefined) throw new Error(`fake transport has no ${request.kind} for ${server}`);
			return typeof value === "string" ? value : JSON.stringify(value);
		},
		async listServers() {
			return list;
		},
		async scanSocketFiles() {
			return sockets;
		},
	};
}

/** Raw Lua JSON for a snapshot, shaped as `fn.json_encode` emits it. */
export function rawSnapshot(overrides = {}) {
	return {
		cwd: "/home/dev/project",
		mode: "n",
		currentFile: "/home/dev/project/src/main.js",
		currentBuffer: { bufnr: 1, name: "/home/dev/project/src/main.js", filetype: "javascript", modified: false, lineCount: 40, listed: true, visible: true },
		cursor: { line: 1, column: 1, lineText: "const x = 1;" },
		surroundingLines: [],
		search: "",
		buffers: [],
		windows: [],
		...overrides,
	};
}

/** A clock you can advance by hand. */
export function fakeClock(start = 1_000_000) {
	let value = start;
	const now = () => value;
	now.advance = (ms) => {
		value += ms;
	};
	return now;
}
