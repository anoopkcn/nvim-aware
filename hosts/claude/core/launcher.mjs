// GENERATED FILE — do not edit. Source: core/launcher.mjs. Regenerate with `npm run build` (or `node scripts/build.mjs`).
/**
 * Generic "launch a CLI pre-connected to Neovim" engine.
 *
 * Both host launchers (claude-nvim, pi-nvim) are thin configs over this:
 * discover the Neovim server (interactive picker when several respond),
 * chdir into that instance's cwd, then exec the real host binary with
 * host-specific args/env.
 *
 * NVIM_AWARE_SERVER is exported to the child automatically when a server was
 * selected, so the host integration skips rediscovery.
 *
 * config:
 *   name              wrapper name used in messages, e.g. "claude-nvim"
 *   binaryName        real binary to launch, e.g. "claude"
 *   realBinaryEnvVar  env var that pins the real binary path
 *   valueFlags        wrapper-only flags that take a value, e.g. ["--nvim-context"];
 *                     parsed into flags["nvim-context"] and stripped from passthrough
 *   buildArgs(ctx)    argv for the real binary; ctx = { passthrough, flags, selected, explicitServer }
 *   buildEnv(ctx)     optional extra env vars for the child; same ctx
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { chooseBestNvimServer, collectServerSummaries } from "./discover.mjs";
import { errorToMessage, safeRealpath } from "./proc.mjs";

export async function runLauncher(config, argv = process.argv.slice(2)) {
	const launchCwd = process.cwd();
	const parsed = parseWrapperArgs(argv, config.valueFlags ?? []);

	let selected;
	try {
		selected = await selectNvimServer({
			name: config.name,
			explicitServer: parsed.explicitServer,
			launchCwd,
		});
	} catch (error) {
		console.error(`${config.name}: ${errorToMessage(error)}`);
	}

	if (selected?.cwd && (await isDirectory(selected.cwd))) {
		process.chdir(selected.cwd);
		console.error(`${config.name}: connected to ${basename(selected.cwd) || selected.cwd} (${selected.server})`);
	} else if (selected?.server) {
		console.error(`${config.name}: connected to ${selected.server}; staying in ${launchCwd}`);
	} else {
		console.error(`${config.name}: no Neovim server selected; starting ${config.binaryName} in the terminal cwd`);
	}

	const context = {
		passthrough: parsed.passthrough,
		flags: parsed.flags,
		selected,
		explicitServer: parsed.explicitServer,
	};

	const realBinary = findRealBinary(config);
	const child = spawn(realBinary, config.buildArgs(context), {
		cwd: process.cwd(),
		stdio: "inherit",
		env: {
			...process.env,
			...(selected?.server ? { NVIM_AWARE_SERVER: selected.server } : {}),
			...(config.buildEnv?.(context) ?? {}),
		},
	});

	child.on("error", (error) => {
		console.error(`${config.name}: failed to start ${realBinary}: ${error.message}`);
		process.exit(1);
	});
	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});
}

/**
 * Strip wrapper-only flags, keeping everything else for the real binary.
 * `--nvim` is the bare opt-in trigger used by shell wrappers; `--nvim=<addr>`
 * is shorthand for `--nvim-server <addr>`.
 */
function parseWrapperArgs(args, valueFlags) {
	const passthrough = [];
	const flags = {};
	let explicitServer;

	outer: for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--nvim") continue;
		if (arg.startsWith("--nvim=")) {
			explicitServer = arg.slice("--nvim=".length);
			continue;
		}
		if (arg === "--nvim-server") {
			explicitServer = requireValue(args, ++i, "--nvim-server");
			continue;
		}
		if (arg.startsWith("--nvim-server=")) {
			explicitServer = arg.slice("--nvim-server=".length);
			continue;
		}
		for (const flag of valueFlags) {
			if (arg === flag) {
				flags[flag.replace(/^--/, "")] = requireValue(args, ++i, flag);
				continue outer;
			}
			if (arg.startsWith(`${flag}=`)) {
				flags[flag.replace(/^--/, "")] = arg.slice(flag.length + 1);
				continue outer;
			}
		}
		passthrough.push(arg);
	}

	return { passthrough, flags, explicitServer };
}

function requireValue(args, index, name) {
	const value = args[index];
	if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`);
	return value;
}

async function selectNvimServer({ name, explicitServer, launchCwd }) {
	const { summaries, failures } = await collectServerSummaries({ explicit: explicitServer });

	if (summaries.length === 0) {
		if (explicitServer) {
			console.error(`${name}: ${explicitServer} did not respond; staying in ${launchCwd}`);
		} else if (failures.length > 0) {
			console.error(`${name}: found Neovim candidates, but none responded; staying in ${launchCwd}`);
		}
		return explicitServer ? { server: explicitServer, cwd: undefined } : undefined;
	}
	if (explicitServer) {
		return summaries.find((summary) => summary.server === explicitServer) ?? summaries[0];
	}
	if (summaries.length === 1) {
		return summaries[0];
	}
	if (process.stdin.isTTY && process.stdout.isTTY) {
		return promptForServer(summaries, launchCwd);
	}

	const selected = chooseBestNvimServer(summaries, launchCwd);
	console.error(
		`${name}: found ${summaries.length} Neovim instances; selected ${basename(selected.cwd) || selected.cwd}. Pass --nvim-server to choose explicitly.`,
	);
	return selected;
}

function promptForServer(summaries, launchCwd) {
	return new Promise((resolveChoice) => {
		const defaultSummary = chooseBestNvimServer(summaries, launchCwd);
		const defaultIndex = Math.max(0, summaries.indexOf(defaultSummary));
		const labels = labelledDirNames(summaries);
		const labelWidth = Math.max(...labels.map((label) => label.length));

		process.stdout.write("\nMultiple Neovim instances found.\n\n");
		summaries.forEach((summary, index) => {
			const marker = index === defaultIndex ? "*" : " ";
			const indexText = `${index + 1})`.padStart(String(summaries.length).length + 1, " ");
			process.stdout.write(`${marker} ${indexText} ${labels[index].padEnd(labelWidth)}  ${summary.cwd}  ${fileDisplay(summary)}\n`);
		});
		process.stdout.write("\n");

		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const ask = () => {
			rl.question(`Connect to Neovim instance [1-${summaries.length}] (default ${defaultIndex + 1}): `, (answer) => {
				const trimmed = answer.trim();
				if (!trimmed) {
					rl.close();
					resolveChoice(defaultSummary);
					return;
				}
				const index = Number.parseInt(trimmed, 10);
				if (Number.isInteger(index) && index >= 1 && index <= summaries.length) {
					rl.close();
					resolveChoice(summaries[index - 1]);
					return;
				}
				process.stdout.write(`Please enter a number from 1 to ${summaries.length}.\n`);
				ask();
			});
		};
		ask();
	});
}

function labelledDirNames(summaries) {
	const counts = new Map();
	for (const summary of summaries) {
		const name = basename(summary.cwd) || summary.cwd;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return summaries.map((summary) => {
		const name = basename(summary.cwd) || summary.cwd;
		if ((counts.get(name) ?? 0) <= 1) return name;
		const parent = basename(dirname(summary.cwd));
		return parent ? `${parent}/${name}` : name;
	});
}

function fileDisplay(summary) {
	if (!summary.currentFile) return "[No Name]";
	const rel = relative(summary.cwd, summary.currentFile);
	const file = rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : summary.currentFile;
	return summary.cursor?.line > 0 ? `${file}:${summary.cursor.line}` : file;
}

function findRealBinary(config) {
	const pinned = process.env[config.realBinaryEnvVar];
	if (pinned) return pinned;

	const current = safeRealpath(process.argv[1]);
	const names = process.platform === "win32"
		? [`${config.binaryName}.cmd`, `${config.binaryName}.exe`, config.binaryName]
		: [config.binaryName];

	for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (!isExecutable(candidate)) continue;
			if (safeRealpath(candidate) === current) continue;
			return candidate;
		}
	}
	return config.binaryName;
}

async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
