/**
 * Self-contained checks for AccountPool scheduling invariants.
 * Run: node test/account-pool.test.js
 */

const assert = require("assert");
const AccountPool = require("../src/auth/AccountPool");

const quietLogger = { debug() {}, error() {}, info() {}, warn() {} };

function makeAuthSource(indices) {
    return { getRotationIndices: () => indices };
}

function makePool(overrides = {}, indices = [1, 2, 3]) {
    return new AccountPool(quietLogger, { maxRequestsPerAccount: 3, ...overrides }, makeAuthSource(indices));
}

async function testSpreadsAcrossAccounts() {
    const pool = makePool();
    const picks = [];
    for (let i = 0; i < 3; i++) picks.push(await pool.acquire("m"));
    assert.deepStrictEqual([...new Set(picks)].sort(), [1, 2, 3], "first N requests must land on distinct accounts");
    console.log("  ok  spreads across accounts instead of stacking on one");
}

async function testHardGate() {
    const pool = makePool();
    const held = [];
    for (let i = 0; i < 9; i++) held.push(await pool.acquire("m"));

    for (const idx of [1, 2, 3]) {
        assert.strictEqual(pool.getInFlight(idx), 3, `account #${idx} must hold exactly 3`);
    }

    let settled = false;
    const queued = pool.acquire("m", { timeoutMs: 5000 }).then(idx => {
        settled = true;
        return idx;
    });
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(settled, false, "10th request must queue, not overflow an account");

    pool.release(held[0]);
    const got = await queued;
    assert.strictEqual(got, held[0], "queued request must take the freed slot");
    assert.ok(pool.getInFlight(got) <= 3, "in-flight must never exceed the cap");
    console.log("  ok  hard gate: caps at 3/account and queues the overflow");
}

async function testAcquireTimeout() {
    const pool = makePool({}, [1]);
    for (let i = 0; i < 3; i++) await pool.acquire("m");
    await assert.rejects(
        () => pool.acquire("m", { timeoutMs: 300 }),
        err => err.statusCode === 429,
        "saturated pool must reject with 429 rather than wait forever"
    );
    console.log("  ok  rejects with 429 once the queue wait elapses");
}

async function testHardFailureCoolsImmediately() {
    const pool = makePool();
    const r = pool.recordFailure(1, "m", 401);
    assert.strictEqual(r.cooled, true, "401 must cool the account on the first hit");
    assert.strictEqual(pool.isCoolingDown(1, "m"), true);

    for (let i = 0; i < 6; i++) {
        assert.notStrictEqual(await pool.acquire("m"), 1, "cooling account must not be selected");
    }
    console.log("  ok  401 cools immediately and is skipped by the selector");
}

async function testSoftFailureNeedsStreak() {
    const pool = makePool({ softFailuresBeforeCooldown: 3 });
    assert.strictEqual(pool.recordFailure(1, "m", 500).cooled, false);
    assert.strictEqual(pool.recordFailure(1, "m", 500).cooled, false);
    assert.strictEqual(pool.isCoolingDown(1, "m"), false, "transient errors must not cool on first occurrences");
    assert.strictEqual(pool.recordFailure(1, "m", 500).cooled, true, "third consecutive 500 cools the account");
    console.log("  ok  500 needs a streak before cooling");
}

async function testSuccessResetsStreak() {
    const pool = makePool({ softFailuresBeforeCooldown: 3 });
    pool.recordFailure(1, "m", 500);
    pool.recordFailure(1, "m", 500);
    pool.recordSuccess(1, "m");
    assert.strictEqual(pool.recordFailure(1, "m", 500).cooled, false, "a success must clear the failure streak");
    console.log("  ok  success clears the soft-failure streak");
}

async function testCooldownIsPerModel() {
    const pool = makePool();
    pool.recordFailure(1, "gemini-3.1-pro-preview", 401);
    assert.strictEqual(pool.isCoolingDown(1, "gemini-3.1-pro-preview"), true);
    assert.strictEqual(
        pool.isCoolingDown(1, "gemini-3.5-flash"),
        false,
        "a failure on one model must not disable the account for others"
    );
    console.log("  ok  cooldown is scoped to (account, model)");
}

async function testCooldownExpires() {
    const pool = makePool({ accountCooldownMs: 120 });
    pool.recordFailure(1, "m", 401);
    assert.strictEqual(pool.isCoolingDown(1, "m"), true);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(pool.isCoolingDown(1, "m"), false, "cooldown must lapse on its own");
    console.log("  ok  account returns to rotation once the cooldown lapses");
}

async function testDeadAfterRepeatedCooldowns() {
    const pool = makePool({ accountCooldownMs: 1, cooldownsBeforeDead: 3 });
    assert.strictEqual(pool.recordFailure(1, "m", 401).dead, false);
    assert.strictEqual(pool.recordFailure(1, "m", 401).dead, false);
    assert.strictEqual(pool.recordFailure(1, "m", 401).dead, true, "third cooldown round marks the account dead");
    console.log("  ok  repeated cooldowns escalate to dead");
}

async function testWarmPreferredOverCold() {
    const pool = makePool({}, [1, 2, 3]);
    pool.setWarmProbe(idx => idx === 3);
    assert.strictEqual(await pool.acquire("m"), 3, "warm account must win over idle-but-cold ones");
    console.log("  ok  prefers warm accounts to avoid cold starts");
}

async function testWarmUsedExclusivelyUntilSaturated() {
    // Mirrors production: a rotation far larger than the warm context pool.
    const rotation = Array.from({ length: 20 }, (_, i) => i + 1);
    const warm = new Set([3, 7]);
    const pool = makePool({ maxRequestsPerAccount: 3 }, rotation);
    pool.setWarmProbe(idx => warm.has(idx));

    // Every warm slot (2 accounts x 3) must be consumed before any cold account is used;
    // sending traffic to a cold account early stalls it behind a browser cold start.
    const picks = [];
    for (let i = 0; i < 6; i++) picks.push(await pool.acquire("m"));
    assert.ok(
        picks.every(p => warm.has(p)),
        `expected only warm accounts while capacity remains, got ${JSON.stringify(picks)}`
    );
    assert.strictEqual(pool.getInFlight(3), 3);
    assert.strictEqual(pool.getInFlight(7), 3);

    // Only once the warm set is full may a cold account take the overflow.
    const overflow = await pool.acquire("m");
    assert.ok(!warm.has(overflow), "overflow must fall through to a cold account, not queue forever");
    console.log("  ok  warm accounts are used exclusively until saturated, then cold takes overflow");
}

async function testReleaseIsBalanced() {
    const pool = makePool();
    const a = await pool.acquire("m");
    pool.release(a);
    pool.release(a); // extra release must not drive the counter negative
    assert.strictEqual(pool.getInFlight(a), 0);
    console.log("  ok  release never drives in-flight below zero");
}

async function testClearCooldownsAfterRelogin() {
    const pool = makePool();
    // Two rounds of 401 leave the account cooling and one round from dead.
    pool.recordFailure(0, "m", 401);
    pool.recordFailure(0, "m", 401);
    assert.strictEqual(pool.isCoolingDown(0, "m"), true);

    const lifted = pool.clearCooldowns(0);
    assert.ok(lifted > 0, "expected at least one cooldown to be lifted");
    assert.strictEqual(pool.isCoolingDown(0, "m"), false);

    // The round counter must reset too: otherwise the next single failure
    // resumes at round 3 of 3 and retires an account that just came back.
    const after = pool.recordFailure(0, "m", 401);
    assert.strictEqual(after.cooled, true, "fresh failure should cool again");
    assert.strictEqual(after.dead, false, "counter must restart, not resume at round 3");
    console.log("  ok  re-login clears cooldowns and the escalation counter");
}

(async () => {
    const tests = [
        testSpreadsAcrossAccounts,
        testHardGate,
        testAcquireTimeout,
        testHardFailureCoolsImmediately,
        testSoftFailureNeedsStreak,
        testSuccessResetsStreak,
        testCooldownIsPerModel,
        testCooldownExpires,
        testDeadAfterRepeatedCooldowns,
        testWarmPreferredOverCold,
        testWarmUsedExclusivelyUntilSaturated,
        testReleaseIsBalanced,
        testClearCooldownsAfterRelogin,
    ];
    console.log("AccountPool invariants");
    for (const t of tests) await t();
    console.log(`\n${tests.length}/${tests.length} passed`);
})().catch(err => {
    console.error("\nFAILED:", err.message);
    process.exit(1);
});
