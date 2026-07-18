#!/usr/bin/env node
/**
 * Materialize the shared core into the self-contained host artifacts:
 *
 *   1. core/*.mjs                       -> hosts/claude/core/             (verbatim copy + banner)
 *   2. hosts/pi/extensions/*.ts + core  -> hosts/pi/dist/nvim-aware-pi.ts (single-file bundle)
 *   3. hosts/pi/bin/pi-nvim + core      -> hosts/pi/dist/pi-nvim         (single-file bundle)
 *
 * The outputs are committed, so installs never need a toolchain. Run with
 * --check to fail (exit 1) when the committed outputs are out of sync.
 *
 * Bundling uses the esbuild CLI, resolved from $ESBUILD, node_modules/.bin
 * (npm install), tools/esbuild (standalone binary), or PATH — in that order.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

function findEsbuild() {
	const candidates = [
		process.env.ESBUILD,
		join(repoRoot, "node_modules", ".bin", "esbuild"),
		join(repoRoot, "tools", "esbuild"),
		"esbuild",
	].filter(Boolean);
	for (const candidate of candidates) {
		if (candidate === "esbuild") return candidate; // resolved via PATH at spawn time
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// try the next candidate
		}
	}
	throw new Error("esbuild not found: run `npm install`, or place a standalone esbuild binary at tools/esbuild");
}

const esbuild = findEsbuild();

async function bundle(entryPath, { externals = [], banner }) {
	const args = [
		entryPath,
		"--bundle",
		"--format=esm",
		"--platform=node",
		...externals.map((name) => `--external:${name}`),
		`--banner:js=${banner}`,
	];
	const { stdout } = await execFileAsync(esbuild, args, { maxBuffer: 16 * 1024 * 1024 });
	return stdout;
}

function banner(source) {
	return `// GENERATED FILE — do not edit. Source: ${source}. Regenerate with \`npm run build\` (or \`node scripts/build.mjs\`).`;
}

/** target path -> { content, executable? } */
const outputs = new Map();

// 1. Vendored core for the Claude plugin (marketplace installs copy only the
//    plugin directory, so the plugin must carry its own copy of core).
//
//    Only `.mjs` files are vendored, and `*.test.mjs` is excluded. Anything core
//    imports at runtime must therefore be a non-test `.mjs` — a sibling asset in
//    another format would not be copied, and the plugin would fail at runtime.
const isCoreModule = (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs");

const coreDir = join(repoRoot, "core");
for (const name of (await readdir(coreDir)).filter(isCoreModule).sort()) {
	const content = await readFile(join(coreDir, name), "utf8");
	outputs.set(join(repoRoot, "hosts/claude/core", name), {
		content: `${banner(`core/${name}`)}\n${content}`,
	});
}

// 2. Single-file Pi extension (installable by copying one file to
//    ~/.pi/agent/extensions). The bundle output is plain ESM, which is valid TS.
outputs.set(join(repoRoot, "hosts/pi/dist/nvim-aware-pi.ts"), {
	content: await bundle(join(repoRoot, "hosts/pi/extensions/nvim-aware-pi.ts"), {
		externals: ["typebox", "@earendil-works/pi-coding-agent"],
		banner: banner("hosts/pi/extensions/nvim-aware-pi.ts"),
	}),
});

// 3. Single-file pi-nvim wrapper (copyable next to the bundled extension).
//    The source is extensionless, so bundle via a temp .mjs entry in the same
//    directory to keep its relative imports resolvable.
const wrapperEntry = join(repoRoot, "hosts/pi/bin/.pi-nvim.entry.mjs");
const wrapperSource = await readFile(join(repoRoot, "hosts/pi/bin/pi-nvim"), "utf8");
await writeFile(wrapperEntry, wrapperSource.replace(/^#!.*\n/, ""));
try {
	outputs.set(join(repoRoot, "hosts/pi/dist/pi-nvim"), {
		content: await bundle(wrapperEntry, {
			banner: `#!/usr/bin/env node\n${banner("hosts/pi/bin/pi-nvim")}`,
		}),
		executable: true,
	});
} finally {
	await rm(wrapperEntry, { force: true });
}

let drift = 0;
for (const [target, { content, executable }] of outputs) {
	const label = relative(repoRoot, target);
	const existing = await readFile(target, "utf8").catch(() => null);
	if (existing === content) continue;

	if (checkOnly) {
		console.error(`out of sync: ${label}`);
		drift++;
		continue;
	}

	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
	if (executable) await chmod(target, 0o755);
	console.log(`wrote ${label}`);
}

if (checkOnly) {
	if (drift > 0) {
		console.error(`\n${drift} generated file(s) out of sync — run the build and commit the result.`);
		process.exit(1);
	}
	console.log("generated files are in sync");
} else {
	console.log("build complete");
}
