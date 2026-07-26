/**
 * File: src/auth/AccountPool.js
 * Description: Per-account scheduling — round-robin selection, in-flight concurrency
 *              gating, and tiered cooldown. Replaces the single global currentAuthIndex
 *              as the source of truth for "which account serves this request".
 *
 * Design notes (why this exists):
 *   The legacy scheduler kept ONE global currentAuthIndex, so N concurrent requests all
 *   hit the same account while every other warm context sat idle. This module hands each
 *   request its own account and caps how many requests a single account carries at once.
 *
 *   Cooldown is keyed by (authIndex, model) rather than by account alone: an account that
 *   fails on one model is routinely fine on another, and blanket-cooling it would shrink
 *   the usable pool for no reason.
 *
 *   Cooldown state lives in memory only. It deliberately does NOT touch AuthSource's
 *   `expired` flag, which is persisted to disk and only cleared when an account is
 *   selected — a state a cooled-down account can never reach, so writing there would
 *   strand the account permanently.
 */

const DEFAULT_MAX_PER_ACCOUNT = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_SOFT_FAILURES_BEFORE_COOLDOWN = 3;
const DEFAULT_COOLDOWNS_BEFORE_DEAD = 3;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 60 * 1000;
const WAITER_POLL_MS = 100;

/** Errors that mean the credential itself is rejected — retrying the same account is futile. */
const HARD_FAILURE_STATUSES = new Set([401, 403]);

class AccountPool {
    constructor(logger, config, authSource) {
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;

        this.maxPerAccount = this._readPositiveInt(config?.maxRequestsPerAccount, DEFAULT_MAX_PER_ACCOUNT);
        this.cooldownMs = this._readPositiveInt(config?.accountCooldownMs, DEFAULT_COOLDOWN_MS);
        this.softFailureLimit = this._readPositiveInt(
            config?.softFailuresBeforeCooldown,
            DEFAULT_SOFT_FAILURES_BEFORE_COOLDOWN
        );
        this.cooldownsBeforeDead = this._readPositiveInt(config?.cooldownsBeforeDead, DEFAULT_COOLDOWNS_BEFORE_DEAD);
        this.acquireTimeoutMs = this._readPositiveInt(config?.acquireTimeoutMs, DEFAULT_ACQUIRE_TIMEOUT_MS);

        /** @type {Map<number, number>} authIndex -> in-flight request count */
        this.inFlight = new Map();
        /** @type {Map<string, {until: number, reason: string}>} "authIndex|model" -> cooldown */
        this.cooldowns = new Map();
        /** @type {Map<string, number>} "authIndex|model" -> consecutive soft failures */
        this.softFailures = new Map();
        /** @type {Map<string, number>} "authIndex|model" -> how many times this pair has been cooled */
        this.cooldownRounds = new Map();

        this._cursor = 0;
        this._waiters = [];

        /**
         * Optional probe telling whether an account already has a live browser context.
         * Warm accounts are preferred so requests avoid a 10-30s cold start, but a cold
         * account is still usable — the request path brings its context up on demand.
         */
        this._isWarm = null;
    }

    /** @param {(authIndex: number) => boolean} fn */
    setWarmProbe(fn) {
        this._isWarm = typeof fn === "function" ? fn : null;
    }

    _readPositiveInt(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    }

    _key(authIndex, model) {
        return `${authIndex}|${model || "*"}`;
    }

    /** Accounts eligible for rotation right now, ignoring cooldown and load. */
    _candidateIndices() {
        const indices = this.authSource.getRotationIndices();
        return Array.isArray(indices) ? indices : [];
    }

    isCoolingDown(authIndex, model, now = Date.now()) {
        const entry = this.cooldowns.get(this._key(authIndex, model));
        if (!entry) return false;
        if (entry.until <= now) {
            this.cooldowns.delete(this._key(authIndex, model));
            this.logger.info(`♻️ [Pool] Account #${authIndex} (${model || "any"}) left cooldown, back in rotation.`);
            return false;
        }
        return true;
    }

    getInFlight(authIndex) {
        return this.inFlight.get(authIndex) || 0;
    }

    /**
     * Pick the least-loaded account that is neither saturated nor cooling down.
     *
     * Warm accounts (live context + socket) are strongly preferred: a cold account has to
     * boot a browser context first, which takes tens of seconds and serialises behind other
     * cold starts. With a rotation far larger than the context pool — 64 accounts against 10
     * warm ones is normal — spreading requests evenly across the whole rotation would send
     * most of them to cold accounts and stall them, so warm accounts are used exclusively
     * whenever any has spare capacity. Cold accounts are only picked when every warm one is
     * saturated, which is also what lets the pool grow beyond its warm set under load.
     */
    _select(model, now = Date.now()) {
        const candidates = this._candidateIndices();
        if (candidates.length === 0) return null;

        let bestWarm = null;
        let bestWarmLoad = Infinity;
        let bestCold = null;
        let bestColdLoad = Infinity;

        for (let offset = 0; offset < candidates.length; offset++) {
            const idx = candidates[(this._cursor + offset) % candidates.length];
            if (this.isCoolingDown(idx, model, now)) continue;

            const load = this.getInFlight(idx);
            if (load >= this.maxPerAccount) continue;

            if (this._isWarm ? this._isWarm(idx) : true) {
                if (load < bestWarmLoad) {
                    bestWarm = idx;
                    bestWarmLoad = load;
                    if (load === 0) break; // idle and warm — cannot do better
                }
            } else if (load < bestColdLoad) {
                bestCold = idx;
                bestColdLoad = load;
            }
        }

        const best = bestWarm !== null ? bestWarm : bestCold;
        if (best !== null) {
            const pos = candidates.indexOf(best);
            this._cursor = (pos + 1) % candidates.length;
        }
        return best;
    }

    /**
     * Reserve a slot on some account for one request. Resolves with the chosen authIndex.
     * When every account is saturated the caller waits rather than overloading an account —
     * a hard gate, not a soft target. Rejects once acquireTimeoutMs elapses.
     */
    async acquire(model, { timeoutMs = this.acquireTimeoutMs } = {}) {
        const immediate = this._select(model);
        if (immediate !== null) {
            this.inFlight.set(immediate, this.getInFlight(immediate) + 1);
            return immediate;
        }

        if (this._candidateIndices().length === 0) {
            throw new Error("No available accounts in rotation.");
        }

        const deadline = Date.now() + timeoutMs;
        return new Promise((resolve, reject) => {
            let timer = null;
            const finish = () => {
                this._waiters = this._waiters.filter(w => w.attempt !== attempt);
                if (timer) clearInterval(timer);
            };
            const attempt = () => {
                const picked = this._select(model);
                if (picked !== null) {
                    this.inFlight.set(picked, this.getInFlight(picked) + 1);
                    finish();
                    resolve(picked);
                    return true;
                }
                if (Date.now() >= deadline) {
                    finish();
                    const err = new Error(
                        `All accounts busy or cooling down; waited ${Math.round(timeoutMs / 1000)}s.`
                    );
                    err.statusCode = 429;
                    reject(err);
                    return true;
                }
                return false;
            };

            // Deliberately not unref'd: a caller is blocked on this timer, so it must keep
            // the event loop alive until the slot is granted or the wait times out.
            timer = setInterval(attempt, WAITER_POLL_MS);
            this._waiters.push({ attempt, timer });
        });
    }

    /** Release the slot held by a request. Must be paired with every acquire(). */
    release(authIndex) {
        if (!Number.isInteger(authIndex)) return;
        const current = this.getInFlight(authIndex);
        if (current <= 1) this.inFlight.delete(authIndex);
        else this.inFlight.set(authIndex, current - 1);

        // Hand the freed slot to the longest-waiting caller that can use it.
        for (const waiter of this._waiters.slice()) {
            if (waiter.attempt()) break;
        }
    }

    /** Clear the soft-failure streak for a pair that just succeeded. */
    recordSuccess(authIndex, model) {
        this.softFailures.delete(this._key(authIndex, model));
    }

    /**
     * Record a failure and cool the account down if warranted.
     *
     * 401/403 mean the credential is rejected outright, so the account is cooled on the
     * first occurrence — retrying it only burns requests. Transient errors (5xx, timeouts)
     * are usually the upstream's fault rather than the account's, so they need to repeat
     * before the account is taken out of rotation.
     *
     * @returns {{cooled: boolean, dead: boolean}}
     */
    recordFailure(authIndex, model, status) {
        const key = this._key(authIndex, model);
        const isHard = HARD_FAILURE_STATUSES.has(Number(status));

        if (!isHard) {
            const streak = (this.softFailures.get(key) || 0) + 1;
            this.softFailures.set(key, streak);
            if (streak < this.softFailureLimit) {
                this.logger.warn(
                    `⚠️ [Pool] Account #${authIndex} (${model || "any"}) soft failure ${streak}/${this.softFailureLimit} (status ${status}).`
                );
                return { cooled: false, dead: false };
            }
        }

        this.softFailures.delete(key);
        const rounds = (this.cooldownRounds.get(key) || 0) + 1;
        this.cooldownRounds.set(key, rounds);
        this.cooldowns.set(key, {
            reason: isHard ? `hard-${status}` : "soft-streak",
            until: Date.now() + this.cooldownMs,
        });

        this.logger.warn(
            `🧊 [Pool] Account #${authIndex} (${model || "any"}) cooling down for ${Math.round(this.cooldownMs / 1000)}s ` +
                `(${isHard ? `status ${status}` : "repeated failures"}, round ${rounds}/${this.cooldownsBeforeDead}).`
        );

        const dead = rounds >= this.cooldownsBeforeDead;
        if (dead) {
            this.logger.error(
                `💀 [Pool] Account #${authIndex} (${model || "any"}) hit ${rounds} cooldown rounds; treating as dead until re-uploaded.`
            );
        }
        return { cooled: true, dead };
    }

    /** Drop all cooldown/failure bookkeeping for an account (e.g. after a fresh auth upload). */
    reset(authIndex) {
        for (const map of [this.cooldowns, this.softFailures, this.cooldownRounds]) {
            for (const key of Array.from(map.keys())) {
                if (key.startsWith(`${authIndex}|`)) map.delete(key);
            }
        }
    }

    /** Snapshot for /api/status and for the invariant assertions in tests. */
    getStats() {
        const now = Date.now();
        const cooling = [];
        for (const [key, entry] of this.cooldowns.entries()) {
            if (entry.until > now) {
                cooling.push({ key, reason: entry.reason, resetInMs: entry.until - now });
            }
        }
        return {
            cooling,
            inFlight: Object.fromEntries(this.inFlight),
            maxPerAccount: this.maxPerAccount,
            rotationSize: this._candidateIndices().length,
            totalInFlight: Array.from(this.inFlight.values()).reduce((a, b) => a + b, 0),
            waiting: this._waiters.length,
        };
    }
}

module.exports = AccountPool;
