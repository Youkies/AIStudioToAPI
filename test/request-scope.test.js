/**
 * Verifies that concurrent requests never observe each other's account.
 *
 * This is the invariant the whole pool rework rests on: the legacy code read a single
 * process-wide currentAuthIndex at several points during a request, so a switch driven
 * by one request could retarget another request mid-flight.
 *
 * Run: node test/request-scope.test.js
 */

const assert = require("assert");
const path = require("path");

const AccountPool = require("../src/auth/AccountPool");
const RequestHandler = require(path.join("..", "src", "core", "RequestHandler"));

const quietLogger = { debug() {}, error() {}, info() {}, warn() {} };

function makeHandler(indices, config = {}) {
    const authSource = {
        accountNameMap: new Map(indices.map(i => [i, `acct-${i}`])),
        getRotationIndices: () => indices,
    };
    const cfg = { maxRequestsPerAccount: 3, poolScheduling: true, ...config };
    const pool = new AccountPool(quietLogger, cfg, authSource);
    const browserManager = { currentAuthIndex: -999, notifyUserActivity() {} };
    const handler = new RequestHandler(
        { usageStatsService: null },
        { getConnectionByAuth: () => ({}) },
        quietLogger,
        browserManager,
        cfg,
        authSource,
        pool
    );
    return { handler, pool };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testNoCrossTalk() {
    const { handler } = makeHandler([1, 2, 3, 4, 5]);

    // Each "request" reads currentAuthIndex repeatedly across await boundaries, the way
    // the real handler does during queue creation, retries and switch handling.
    const runOne = async label =>
        handler._withPooledAccount("m", async assigned => {
            const seen = [handler.currentAuthIndex];
            await sleep(5 + (label % 7));
            seen.push(handler.currentAuthIndex);
            await sleep(3);
            seen.push(handler.currentAuthIndex);
            assert.ok(
                seen.every(v => v === assigned),
                `request ${label} saw ${JSON.stringify(seen)} but was assigned ${assigned}`
            );
            return assigned;
        });

    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => runOne(i)));
    const used = new Set(results.map(r => r.result));
    assert.ok(used.size >= 3, `expected traffic on several accounts, got ${used.size}`);
    console.log(`  ok  15 concurrent requests kept their own account (spread over ${used.size} accounts)`);
}

async function testGlobalSwitchDoesNotStealInFlightRequest() {
    const { handler } = makeHandler([1, 2, 3]);

    await handler._withPooledAccount("m", async assigned => {
        const before = handler.currentAuthIndex;
        // Simulate another request driving a global account switch mid-flight.
        handler.authSwitcher.currentAuthIndex = 999;
        await sleep(10);
        const after = handler.currentAuthIndex;
        assert.strictEqual(before, assigned);
        assert.strictEqual(after, assigned, "a global switch must not retarget an in-flight request");
    });
    console.log("  ok  a global switch cannot retarget an in-flight request");
}

async function testFallsBackToGlobalOutsideScope() {
    const { handler } = makeHandler([1, 2, 3]);
    handler.authSwitcher.currentAuthIndex = 7;
    assert.strictEqual(handler.currentAuthIndex, 7, "outside a request, the global value must still apply");
    console.log("  ok  falls back to the global index outside a scoped request");
}

async function testSlotsAreReleasedOnThrow() {
    const { handler, pool } = makeHandler([1]);
    await assert.rejects(() =>
        handler._withPooledAccount("m", async () => {
            throw new Error("boom");
        })
    );
    assert.strictEqual(pool.getInFlight(1), 0, "a failed request must not leak its slot");
    console.log("  ok  slots are released even when the handler throws");
}

async function testDisabledPoolKeepsLegacyPath() {
    const { handler } = makeHandler([1, 2, 3], { poolScheduling: false });
    handler.authSwitcher.currentAuthIndex = 42;
    const out = await handler._withPooledAccount("m", async assigned => {
        assert.strictEqual(assigned, null, "pool must not assign when scheduling is disabled");
        return handler.currentAuthIndex;
    });
    assert.strictEqual(out.result, 42, "legacy path must keep using the global index");
    assert.strictEqual(out.pooled, false);
    console.log("  ok  POOL_SCHEDULING=false restores the legacy single-account path");
}

(async () => {
    const tests = [
        testNoCrossTalk,
        testGlobalSwitchDoesNotStealInFlightRequest,
        testFallsBackToGlobalOutsideScope,
        testSlotsAreReleasedOnThrow,
        testDisabledPoolKeepsLegacyPath,
    ];
    console.log("Per-request account binding");
    for (const t of tests) await t();
    console.log(`\n${tests.length}/${tests.length} passed`);
})().catch(err => {
    console.error("\nFAILED:", err.message);
    process.exit(1);
});
