import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseBestNvimServer, createDiscovery, describeDiscoveryFailure, resolveNvimServer } from "../core/discovery.mjs";
import { createFakeTransport } from "./helpers/fake-transport.mjs";

const summary = (cwd, currentFile = "") => ({ summary: JSON.stringify({ cwd, currentFile, cursor: { line: 1, column: 1 } }) });

// ---------------------------------------------------------------------------
// Selection precedence. `isInside` is pure path.relative, so these synthetic
// paths need not exist.
// ---------------------------------------------------------------------------

const exact = { server: "/tmp/a", cwd: "/home/dev/project", currentFile: "" };
const byFile = { server: "/tmp/b", cwd: "/elsewhere", currentFile: "/home/dev/project/src/main.js" };
const byDir = { server: "/tmp/c", cwd: "/home/dev", currentFile: "" };
const unrelated = { server: "/tmp/d", cwd: "/var/tmp", currentFile: "" };

test("exact cwd match wins", () => {
	assert.equal(chooseBestNvimServer([unrelated, byDir, byFile, exact], "/home/dev/project").server, "/tmp/a");
});

test("file containment beats directory containment", () => {
	assert.equal(chooseBestNvimServer([unrelated, byDir, byFile], "/home/dev/project").server, "/tmp/b");
});

test("directory containment beats an unrelated instance", () => {
	assert.equal(chooseBestNvimServer([unrelated, byDir], "/home/dev/project").server, "/tmp/c");
});

test("falls back to the first candidate when nothing matches", () => {
	assert.equal(chooseBestNvimServer([unrelated], "/home/dev/project").server, "/tmp/d");
});

test("an empty candidate list yields undefined rather than throwing", () => {
	// Total, so the interactive picker can no longer throw inside a Promise
	// executor where the rejection would go nowhere useful.
	assert.equal(chooseBestNvimServer([], "/home/dev/project"), undefined);
});

// ---------------------------------------------------------------------------
// Discovery itself.
// ---------------------------------------------------------------------------

test("an explicit address is trusted without a probe", async () => {
	const transport = createFakeTransport({});
	const result = await createDiscovery({ transport, env: {} }).discover({
		explicit: "/tmp/pinned",
		cwd: "/home/dev",
		probeExplicit: false,
	});
	assert.equal(result.best.server, "/tmp/pinned");
	assert.equal(result.best.probed, false);
	assert.equal(result.source, "explicit");
	assert.equal(transport.calls.length, 0, "no round-trip");
});

test("probeExplicit checks the address instead of trusting it", async () => {
	const transport = createFakeTransport({ responses: { "/tmp/pinned": summary("/home/dev/project") } });
	const result = await createDiscovery({ transport, env: {} }).discover({
		explicit: "/tmp/pinned",
		cwd: "/home/dev/project",
		probeExplicit: true,
	});
	assert.equal(transport.calls.length, 1);
	assert.equal(result.best.cwd, "/home/dev/project", "the probe supplies the instance cwd");
	assert.equal(result.best.probed, true);
});

test("env addresses are preferred over serverlist and tagged as such", async () => {
	const transport = createFakeTransport({
		responses: { "/tmp/from-env": summary("/home/dev/project"), "/tmp/from-list": summary("/other") },
		list: ["/tmp/from-list"],
	});
	const result = await createDiscovery({ transport, env: { NVIM: "/tmp/from-env" } }).discover({ cwd: "/home/dev/project" });
	assert.equal(result.best.server, "/tmp/from-env");
	assert.equal(result.source, "env");
	assert.equal(result.candidates.length, 2);
});

test("the socket scan runs only when nothing else answers", async () => {
	const responsive = createFakeTransport({
		responses: { "/tmp/live": summary("/home/dev/project") },
		list: ["/tmp/live"],
		sockets: ["/tmp/scanned"],
	});
	const found = await createDiscovery({ transport: responsive, env: {} }).discover({ cwd: "/home/dev/project" });
	assert.equal(found.source, "serverlist");
	assert.ok(!found.candidates.some((c) => c.server === "/tmp/scanned"), "scan not consulted");

	const silent = createFakeTransport({
		responses: { "/tmp/scanned": summary("/home/dev/project") },
		list: ["/tmp/dead"],
		sockets: ["/tmp/scanned"],
	});
	const scanned = await createDiscovery({ transport: silent, env: {} }).discover({ cwd: "/home/dev/project" });
	assert.equal(scanned.best.server, "/tmp/scanned");
	assert.equal(scanned.source, "scan");
});

test("unreachable candidates become failures, not exceptions", async () => {
	const transport = createFakeTransport({ list: ["/tmp/dead"] });
	const result = await createDiscovery({ transport, env: {} }).discover({ cwd: "/home/dev" });
	assert.equal(result.best, null);
	assert.equal(result.source, "none");
	assert.equal(result.candidates.length, 0);
	assert.match(result.failures[0], /\/tmp\/dead: /);
});

test("duplicate addresses across sources are collapsed", async () => {
	const transport = createFakeTransport({
		responses: { "/tmp/same": summary("/home/dev") },
		list: ["/tmp/same"],
	});
	const result = await createDiscovery({ transport, env: { NVIM: "/tmp/same", NVIM_LISTEN_ADDRESS: "/tmp/same" } }).discover({ cwd: "/home/dev" });
	assert.equal(result.candidates.length, 1);
});

test("resolveNvimServer throws a descriptive error when nothing answers", async () => {
	const transport = createFakeTransport({});
	await assert.rejects(() => resolveNvimServer({ transport, env: {}, cwd: "/home/dev" }), /No Neovim server found/);

	const dead = createFakeTransport({ list: ["/tmp/dead"] });
	await assert.rejects(() => resolveNvimServer({ transport: dead, env: {}, cwd: "/home/dev" }), /none responded/);
});

test("failure messages distinguish absence from unresponsiveness", () => {
	assert.match(describeDiscoveryFailure({ failures: [] }), /No Neovim server found/);
	assert.match(describeDiscoveryFailure({ failures: ["/tmp/a: refused"] }), /none responded.*\/tmp\/a: refused/);
});
