import assert from "node:assert/strict";
import { test } from "node:test";
import { createNvimSession } from "../core/session.mjs";
import { SnapshotShapeError } from "../core/snapshot.mjs";
import { createFakeTransport, fakeClock, rawSnapshot } from "./helpers/fake-transport.mjs";

/** A session wired to a fake transport and a counting resolver. */
function harness({ responses, resolveTo = ["/tmp/nvim-a"], ...options } = {}) {
	const addresses = [...resolveTo];
	const resolves = [];
	const transport = createFakeTransport({
		responses: responses ?? { "/tmp/nvim-a": { snapshot: rawSnapshot() } },
	});
	const now = fakeClock();
	const session = createNvimSession({
		transport,
		now,
		cwd: "/home/dev/project",
		resolve: async () => {
			const server = addresses.length > 1 ? addresses.shift() : addresses[0];
			resolves.push(server);
			if (server instanceof Error) throw server;
			return { server, candidateCount: 1 };
		},
		...options,
	});
	return { session, transport, now, resolves };
}

test("resolves the server once and reuses it", async () => {
	const { session, resolves } = harness();
	await session.snapshot();
	await session.snapshot();
	assert.equal(resolves.length, 1);
});

test("concurrent first callers share one discovery", async () => {
	const { session, resolves } = harness();
	await Promise.all([session.snapshot(), session.snapshot(), session.snapshot()]);
	assert.equal(resolves.length, 1);
});

test("concurrent identical fetches share one round-trip", async () => {
	const { session, transport } = harness();
	await Promise.all([session.snapshot(), session.snapshot()]);
	assert.equal(transport.calls.length, 1);
});

test("serves from cache within the TTL and refetches after it", async () => {
	const { session, transport, now } = harness({ ttlMs: 750 });
	await session.snapshot();
	now.advance(500);
	await session.snapshot();
	assert.equal(transport.calls.length, 1, "still within TTL");

	now.advance(500);
	await session.snapshot();
	assert.equal(transport.calls.length, 2, "TTL expired");
});

test("ttlMs 0 never serves from cache", async () => {
	const { session, transport } = harness({ ttlMs: 0 });
	await session.snapshot();
	await session.snapshot();
	assert.equal(transport.calls.length, 2);
});

test("force bypasses a live TTL entry", async () => {
	const { session, transport, now } = harness({ ttlMs: 10_000 });
	await session.snapshot();
	now.advance(10);
	await session.snapshot({ force: true });
	assert.equal(transport.calls.length, 2);
});

test("a failed fetch drops the remembered server", async () => {
	const { session, resolves } = harness({
		responses: {
			"/tmp/nvim-a": (request, n) => (n === 2 ? new Error("connection refused") : rawSnapshot()),
			"/tmp/nvim-b": { snapshot: rawSnapshot({ cwd: "/second" }) },
		},
		resolveTo: ["/tmp/nvim-a", "/tmp/nvim-b"],
		rediscoverBackoffMs: 0,
	});

	await session.snapshot();
	await assert.rejects(() => session.snapshot(), /connection refused/);

	const recovered = await session.snapshot();
	assert.equal(resolves.length, 2, "re-resolved after the failure");
	assert.equal(recovered.cwd, "/second");
});

test("a shape error does NOT drop the remembered server", async () => {
	// Rediscovering cannot fix contract drift; it would just burn a round-trip.
	const { session, resolves } = harness({
		responses: { "/tmp/nvim-a": () => "not json at all" },
	});
	await assert.rejects(() => session.snapshot(), SnapshotShapeError);
	await assert.rejects(() => session.snapshot(), SnapshotShapeError);
	assert.equal(resolves.length, 1);
});

test("backoff suppresses rediscovery after a failure", async () => {
	const { session, resolves, now } = harness({
		resolveTo: [new Error("no Neovim server found")],
		rediscoverBackoffMs: 10_000,
	});

	await assert.rejects(() => session.snapshot(), /no Neovim server found/);
	await assert.rejects(() => session.snapshot(), /no Neovim server found/);
	assert.equal(resolves.length, 1, "second attempt short-circuited");

	now.advance(10_001);
	await assert.rejects(() => session.snapshot(), /no Neovim server found/);
	assert.equal(resolves.length, 2, "retried once the backoff elapsed");
});

test("stale fallback returns the old snapshot, a warning, and uses the short budget", async () => {
	const { session, transport, now } = harness({
		responses: { "/tmp/nvim-a": (request, n) => (n === 1 ? rawSnapshot({ cwd: "/original" }) : new Error("timed out")) },
		ttlMs: 750,
		staleTimeoutMs: 800,
		defaultTimeoutMs: 2000,
	});

	await session.snapshot();
	now.advance(1000);

	const result = await session.snapshotOrStale();
	assert.equal(result.stale, true);
	assert.equal(result.snapshot.cwd, "/original", "returns the previous snapshot");
	assert.match(result.warning, /timed out/);
	assert.equal(transport.calls.at(-1).timeoutMs, 800, "short budget applies only with a fallback");
});

test("stale fallback serves the cache untouched within the TTL", async () => {
	const { session, transport, now } = harness({ ttlMs: 750, staleTimeoutMs: 800 });
	await session.snapshot();
	now.advance(100);
	const result = await session.snapshotOrStale();
	assert.equal(result.stale, false);
	assert.equal(transport.calls.length, 1);
});

test("without a fallback, a failed refresh rejects and uses the full budget", async () => {
	const { session, transport } = harness({
		responses: { "/tmp/nvim-a": () => new Error("timed out") },
		ttlMs: 750,
		staleTimeoutMs: 800,
		defaultTimeoutMs: 2000,
	});
	await assert.rejects(() => session.snapshotOrStale(), /timed out/);
	assert.equal(transport.calls.at(-1).timeoutMs, 2000);
});

test("the cache is bounded", async () => {
	const { session } = harness({ ttlMs: 10_000, maxCacheEntries: 3 });
	for (const maxBuffers of [1, 2, 3, 4, 5]) {
		await session.snapshot({ limits: { maxBuffers } });
	}
	assert.equal(session.stats().cacheSize, 3);
});

test("invalidate clears both the server and the cache", async () => {
	const { session, resolves, transport } = harness({ ttlMs: 10_000 });
	await session.snapshot();
	session.invalidate();
	await session.snapshot();
	assert.equal(resolves.length, 2);
	assert.equal(transport.calls.length, 2);
});

test("an explicit timeout overrides the default", async () => {
	const { session, transport } = harness({ defaultTimeoutMs: 2000 });
	await session.snapshot({ timeoutMs: 1500 });
	assert.equal(transport.calls[0].timeoutMs, 1500);
});
