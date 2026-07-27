/**
 * File: src/login/LoginQueue.js
 * Description: Serialises login attempts and publishes their state, so a batch
 *              of expired accounts can be refreshed unattended without a bad
 *              script burning through every credential it owns.
 *
 * Concurrency defaults to 1: a Camoufox instance costs ~400MB next to a context
 * pool that already sits at ~3.1GB, and one account at a time is also the
 * gentlest pattern towards Google. It is adjustable at runtime because the
 * right number depends on the container's headroom, not on anything we can
 * decide here.
 */

const { EventEmitter } = require("events");

const DEFAULTS = {
    breakerThreshold: 3, // consecutive failed accounts before the queue stops
    concurrency: 1,
    mode: "manual", // "manual" waits for start(); "auto" drains as items arrive
    perAccountTimeoutMs: 300000,
};

class LoginQueue extends EventEmitter {
    /**
     * @param {object} opts
     * @param {object} opts.logger
     * @param {function} opts.runner - async (account, {attemptId, onStage}) => result
     * @param {object} [opts.settings] - Overrides for DEFAULTS.
     */
    constructor({ logger, runner, settings = {} }) {
        super();
        this.logger = logger;
        this.runner = runner;
        this.settings = { ...DEFAULTS, ...settings };

        this.pending = []; // [{ email, priority, queuedAt }]
        this.active = new Map(); // email -> { startedAt, stage }
        this.history = []; // newest first, capped
        this.paused = this.settings.mode === "manual";
        this.consecutiveFailures = 0;
        this.breakerTripped = false;
        this._draining = false;
        this._seq = 0;
    }

    /** Queue accounts, skipping ones already queued or running. Returns those added. */
    enqueue(emails, { priority = false, reason = "" } = {}) {
        const added = [];
        for (const raw of [].concat(emails)) {
            const email = String(raw || "").trim();
            if (!email) continue;
            if (this.active.has(email) || this.pending.some(p => p.email === email)) continue;

            const item = { email, priority, queuedAt: Date.now(), reason };
            if (priority) this.pending.unshift(item);
            else this.pending.push(item);
            added.push(email);
        }
        if (added.length) {
            this.logger.info(`[LoginQueue] Queued ${added.length} account(s)${reason ? ` (${reason})` : ""}.`);
            this.emit("queued", added);
            this._drain();
        }
        return added;
    }

    dequeue(email) {
        const before = this.pending.length;
        this.pending = this.pending.filter(p => p.email !== email);
        return this.pending.length < before;
    }

    /** Move an account to the front without re-queuing it. */
    promote(email) {
        const idx = this.pending.findIndex(p => p.email === email);
        if (idx <= 0) return false;
        const [item] = this.pending.splice(idx, 1);
        item.priority = true;
        this.pending.unshift(item);
        return true;
    }

    start() {
        this.paused = false;
        this.breakerTripped = false;
        this.consecutiveFailures = 0;
        this.logger.info("[LoginQueue] Started.");
        this.emit("started");
        this._drain();
    }

    pause(reason = "manual") {
        this.paused = true;
        this.logger.info(`[LoginQueue] Paused (${reason}).`);
        this.emit("paused", reason);
    }

    clear() {
        const dropped = this.pending.length;
        this.pending = [];
        return dropped;
    }

    updateSettings(patch) {
        const next = { ...this.settings };
        if (Number.isFinite(patch.concurrency)) next.concurrency = Math.max(1, Math.min(5, patch.concurrency));
        if (Number.isFinite(patch.perAccountTimeoutMs)) {
            next.perAccountTimeoutMs = Math.max(30000, Math.min(1800000, patch.perAccountTimeoutMs));
        }
        if (Number.isFinite(patch.breakerThreshold)) next.breakerThreshold = Math.max(1, patch.breakerThreshold);
        if (patch.mode === "auto" || patch.mode === "manual") next.mode = patch.mode;

        this.settings = next;
        this.logger.info(`[LoginQueue] Settings updated: ${JSON.stringify(next)}`);
        // A raised concurrency should take effect without waiting for the next
        // enqueue, and switching to auto should get things moving.
        if (next.mode === "auto" && this.breakerTripped === false) this.paused = false;
        this._drain();
        return next;
    }

    status() {
        return {
            active: [...this.active.entries()].map(([email, v]) => ({
                elapsedMs: Date.now() - v.startedAt,
                email,
                stage: v.stage,
            })),
            breakerTripped: this.breakerTripped,
            consecutiveFailures: this.consecutiveFailures,
            history: this.history.slice(0, 50),
            paused: this.paused,
            pending: this.pending.map(p => ({ email: p.email, queuedAt: p.queuedAt, reason: p.reason })),
            settings: this.settings,
        };
    }

    async _drain() {
        if (this._draining) return;
        this._draining = true;
        try {
            while (
                !this.paused &&
                !this.breakerTripped &&
                this.pending.length &&
                this.active.size < this.settings.concurrency
            ) {
                const item = this.pending.shift();
                this._run(item); // deliberately not awaited: fills all slots
            }
        } finally {
            this._draining = false;
        }
    }

    async _run(item) {
        const attemptId = `${item.email.split("@")[0]}-${Date.now()}-${++this._seq}`;
        const entry = { stage: "starting", startedAt: Date.now() };
        this.active.set(item.email, entry);
        this.emit("attempt:start", { attemptId, email: item.email });

        let result;
        try {
            result = await this.runner(item.email, {
                attemptId,
                onStage: stage => {
                    entry.stage = stage;
                    this.emit("attempt:stage", { email: item.email, stage });
                },
                timeoutMs: this.settings.perAccountTimeoutMs,
            });
        } catch (err) {
            result = { error: String(err).slice(0, 300), ok: false, stage: "exception" };
        } finally {
            this.active.delete(item.email);
        }

        const record = {
            attemptId,
            durationMs: Date.now() - entry.startedAt,
            email: item.email,
            finishedAt: Date.now(),
            ok: Boolean(result?.ok),
            stage: result?.stage || "unknown",
            ...(result?.error ? { error: result.error } : {}),
        };
        this.history.unshift(record);
        if (this.history.length > 200) this.history.length = 200;

        if (record.ok) {
            this.consecutiveFailures = 0;
        } else {
            this.consecutiveFailures += 1;
            if (this.consecutiveFailures >= this.settings.breakerThreshold) {
                // Stop rather than work through the whole list: a broken
                // selector or a wrong build fails every account identically,
                // and each failed attempt is a real signal to Google.
                this.breakerTripped = true;
                this.paused = true;
                this.logger.error(
                    `🛑 [LoginQueue] ${this.consecutiveFailures} consecutive failures — queue halted. ` +
                        `Inspect the latest attempts before resuming.`
                );
                this.emit("breaker", {
                    consecutiveFailures: this.consecutiveFailures,
                    history: this.history.slice(0, 5),
                });
            }
        }

        this.emit("attempt:done", record);
        this._drain();
    }
}

module.exports = { LOGIN_QUEUE_DEFAULTS: DEFAULTS, LoginQueue };
