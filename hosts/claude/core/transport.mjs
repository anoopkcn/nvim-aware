// GENERATED FILE — do not edit. Source: core/transport.mjs. Regenerate with `npm run build` (or `node scripts/build.mjs`).
/**
 * The seam between this project and the outside world.
 *
 * Everything that spawns a process or touches the filesystem lives behind this
 * interface, so the rest of core can be exercised without a running editor.
 * Two adapters satisfy it: `createSpawnTransport` in production, and a fake in
 * the test suite.
 *
 * Requests are tagged objects rather than bare expression strings so a fake can
 * dispatch on `kind` instead of pattern-matching Lua source.
 */
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFirstJsonObject, runProcess, uniqueExistingRealpaths } from "./proc.mjs";

const DEFAULT_LIST_TIMEOUT_MS = 1500;
const MAX_SOCKETS = 3000;
const SOCKET_SCAN_DEPTH = 5;

/**
 * @typedef {object} NvimTransport
 * @property {(server: string, request: {kind: string, expression: string}, options?: {timeoutMs?: number}) => Promise<string>} evaluate
 * @property {(options?: {timeoutMs?: number}) => Promise<string[]>} listServers
 * @property {() => Promise<string[]>} scanSocketFiles
 */

/** @returns {NvimTransport} */
export function createSpawnTransport({ run = runProcess, env = process.env, platform = process.platform } = {}) {
	return {
		async evaluate(server, request, options = {}) {
			const result = await run("nvim", ["--server", server, "--remote-expr", request.expression], {
				timeoutMs: options.timeoutMs,
			});
			if (result.code !== 0) {
				throw new Error(`nvim --remote-expr failed: ${result.stderr.trim() || result.stdout.trim()}`);
			}
			// Neovim writes the expression result to stdout, but some builds
			// surface it on stderr; prefer stdout and fall back.
			return result.stdout.trim() || result.stderr.trim();
		},

		/** Ask a throwaway headless Neovim which servers are running. Never throws. */
		async listServers(options = {}) {
			try {
				const result = await run(
					"nvim",
					["--headless", "--clean", "-n", "+echo json_encode({'self': v:servername, 'servers': serverlist()})", "+qa"],
					{ timeoutMs: options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS },
				);
				const parsed = parseFirstJsonObject(result.stdout + result.stderr);
				if (!Array.isArray(parsed?.servers)) return [];
				// Exclude the throwaway instance we just spawned.
				return parsed.servers.filter((server) => typeof server === "string" && server && server !== parsed.self);
			} catch {
				return [];
			}
		},

		/** Scan likely runtime directories for Neovim-looking unix sockets. Never throws. */
		async scanSocketFiles() {
			if (platform === "win32") return [];

			const roots = uniqueExistingRealpaths([env.XDG_RUNTIME_DIR, env.TMPDIR, tmpdir(), "/tmp"]);
			const sockets = [];
			const seen = new Set();

			const addSocket = (path) => {
				if (seen.has(path)) return;
				seen.add(path);
				sockets.push(path);
			};

			const walk = async (dir, depth, inNvimishDir) => {
				if (depth < 0 || sockets.length >= MAX_SOCKETS) return;

				let entries;
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}

				for (const entry of entries) {
					if (sockets.length >= MAX_SOCKETS) return;

					const path = join(dir, entry.name);
					const nameIsNvimish = entry.name.toLowerCase().includes("nvim");
					const pathIsNvimish = inNvimishDir || nameIsNvimish || path.toLowerCase().includes("nvim");

					if (entry.isSocket?.()) {
						if (pathIsNvimish) addSocket(path);
						continue;
					}

					if (!entry.isDirectory()) {
						if (!pathIsNvimish) continue;
						try {
							if ((await lstat(path)).isSocket()) addSocket(path);
						} catch {
							// Entry disappeared or cannot be inspected.
						}
						continue;
					}

					if (depth === 0) continue;
					if (pathIsNvimish) await walk(path, depth - 1, true);
				}
			};

			for (const root of roots) {
				await walk(root, SOCKET_SCAN_DEPTH, false);
			}

			return sockets;
		},
	};
}
