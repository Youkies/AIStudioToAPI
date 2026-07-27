/**
 * File: src/login/LoginService.js
 * Description: Wires the account store, the queue and the browser login into
 *              one unit, and lands a fresh session where the proxy can use it.
 *
 * Publishing is the delicate half. A refreshed account must replace its own
 * auth file rather than pile up a new index, and the pool must be told the old
 * verdict no longer applies — otherwise a successful re-login sits out the rest
 * of its cooldown for no reason.
 */

const fs = require("fs");
const path = require("path");

const { AccountStore } = require("./AccountStore");
const { GoogleLogin } = require("./GoogleLogin");
const { LoginQueue } = require("./LoginQueue");

class LoginService {
    /**
     * @param {object} opts
     * @param {object} opts.logger
     * @param {object} [opts.authSource] - ais AuthSource, for locating/reloading auth files.
     * @param {object} [opts.accountPool] - ais AccountPool, to lift cooldowns after a refresh.
     * @param {object} [opts.browserManager] - ais BrowserManager, to rebuild a context.
     * @param {object} [opts.settings]
     */
    constructor({ logger, authSource, accountPool, browserManager, settings = {} }) {
        this.logger = logger;
        this.authSource = authSource;
        this.accountPool = accountPool;
        this.browserManager = browserManager;

        this.authDir = path.join(process.cwd(), "configs", "auth");
        // Both of these live under configs/auth because that is the only path
        // Zeabur mounts a persistent volume on. Anything written elsewhere —
        // configs/ itself, data/ — is part of the image layer and vanishes on
        // the next deploy, which for the credential store would mean losing
        // every password on a routine push.
        this.storePath = path.join(this.authDir, "_accounts.json");
        this.diagnosticsDir = path.join(this.authDir, "_diagnostics");

        this.store = new AccountStore(this.storePath, logger);
        this.login = new GoogleLogin({
            diagnosticsDir: this.diagnosticsDir,
            headless: settings.headless !== false,
            logger,
        });
        this.queue = new LoginQueue({
            logger,
            runner: (email, opts) => this._loginOne(email, opts),
            settings,
        });

        this.queue.on("breaker", () => {
            this.logger.error("🛑 [LoginService] Circuit breaker tripped; no further accounts will be attempted.");
        });
    }

    /** Import pasted credential lines. Returns a summary for the UI. */
    importText(text) {
        const { parsed, skipped } = AccountStore.parseText(text);
        let created = 0;
        let updated = 0;
        for (const rec of parsed) {
            const existed = Boolean(this.store.get(rec.email));
            this.store.upsert(rec);
            if (existed) updated += 1;
            else created += 1;
        }
        if (parsed.length) this.store.save();
        this.logger.info(`[LoginService] Import: ${created} new, ${updated} updated, ${skipped.length} skipped.`);
        return { created, skipped, total: parsed.length, updated };
    }

    /** One attempt: log in, then publish the session. Called by the queue. */
    async _loginOne(email, { attemptId, onStage, timeoutMs } = {}) {
        const rec = this.store.get(email);
        if (!rec) return { ok: false, stage: "unknown_account" };
        if (!rec.password) return { ok: false, stage: "no_password" };

        if (Number.isFinite(timeoutMs)) this.login.timeoutMs = timeoutMs;

        const result = await this.login.login(
            {
                email: rec.email,
                password: rec.password,
                proxy: AccountStore.toPlaywrightProxy(rec),
                totp_secret: rec.totp_secret,
            },
            { attemptId, onStage }
        );

        if (result.ok) {
            try {
                const filename = await this.publish(rec, result.storageState);
                result.filename = filename;
            } catch (err) {
                this.logger.error(`[LoginService] ${email} logged in but publishing failed: ${err.message}`);
                return { error: err.message, ok: false, stage: "publish_failed" };
            }
        }

        this.store.markAttempt(email, {
            attemptId,
            error: result.error || result.diagnostics?.reason,
            ok: result.ok,
            stage: result.stage,
        });
        // An account that signed in but never cleared the gate will answer 403
        // on every call. Recording it separately from a login failure is what
        // lets the page say "re-run the terms step" instead of "log in again".
        if (result.ok) {
            const rec2 = this.store.get(email);
            if (rec2) {
                rec2.terms_ok = result.termsOk === true;
                rec2.terms_stage = result.termsStage || "";
                this.store.save();
            }
        }
        return result;
    }

    /**
     * Write the session where the proxy reads it, then clear the way back.
     *
     * The proxy line travels inside the auth file on purpose: Google binds a
     * session cookie to the IP that minted it, so the server has to replay it
     * from the same exit node or lose it within hours.
     */
    async publish(rec, storageState) {
        fs.mkdirSync(this.authDir, { recursive: true });

        const payload = {
            accountName: rec.email,
            cookies: storageState.cookies,
            origins: storageState.origins || [],
        };
        const proxyLine = AccountStore.toProxyLine(rec);
        if (proxyLine) payload.proxy = proxyLine;

        const index = this._resolveAuthIndex(rec.email);
        const filename = `auth-${index}.json`;
        const filePath = path.join(this.authDir, filename);
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
        fs.renameSync(tmp, filePath);

        rec.auth_index = index;
        rec.published_at = Date.now();
        this.store.save();

        this.authSource?.reloadAuthSources?.();

        // The account was very likely cooling on the 401 that sent it here.
        // Without this it stays benched for the remainder of that window even
        // though the credential that caused it is gone.
        this.accountPool?.clearCooldowns?.(index);

        // Reloading the auth file is not enough: a live context is still driving
        // a browser holding the session this login just replaced, so it keeps
        // answering with the state we were trying to fix. Dropping it makes the
        // next request build a fresh one from the new cookies.
        await this._recycleContext(index, rec.email);

        this.logger.info(`[LoginService] Published ${rec.email} → ${filename}${proxyLine ? " (with proxy)" : ""}`);
        return filename;
    }

    /**
     * Drop the browser context still running on the credentials we replaced.
     *
     * Rebuilding is left to the request path rather than done here: the pool is
     * capped, so forcing one open now could evict a context that is busy
     * serving, and a re-logged account is not necessarily one that is about to
     * be used. The close itself defers while requests are in flight.
     */
    async _recycleContext(authIndex, email) {
        const bm = this.browserManager;
        if (!bm?.contexts?.has?.(authIndex)) return false;

        try {
            await bm._closeContextForPoolIfPossible(authIndex, "relogin");
            this.logger.info(`[LoginService] Recycled context #${authIndex} (${email}) onto the new session.`);
            return true;
        } catch (err) {
            // The account is published either way; a stale context only costs
            // it the requests it fails until the pool rebalances.
            this.logger.warn(`[LoginService] Could not recycle context #${authIndex}: ${err.message}`);
            return false;
        }
    }

    /**
     * Reuse this account's existing slot; only take a new index for a newcomer.
     *
     * Appending would leave the stale file behind, and AuthSource dedupes by
     * email preferring the highest index — so the account would work, but its
     * dead twin would linger in every listing.
     */
    _resolveAuthIndex(email) {
        const target = String(email).toLowerCase();
        if (Number.isInteger(this.store.get(email)?.auth_index)) {
            return this.store.get(email).auth_index;
        }

        let maxIndex = -1;
        let existing = null;
        for (const file of fs.existsSync(this.authDir) ? fs.readdirSync(this.authDir) : []) {
            const m = /^auth-(\d+)\.json$/.exec(file);
            if (!m) continue;
            const idx = Number(m[1]);
            maxIndex = Math.max(maxIndex, idx);
            if (existing !== null) continue;
            try {
                const body = JSON.parse(fs.readFileSync(path.join(this.authDir, file), "utf8"));
                if (String(body.accountName || "").toLowerCase() === target) existing = idx;
            } catch {
                /* unreadable file: not a match */
            }
        }
        return existing !== null ? existing : maxIndex + 1;
    }

    /** Read back a stored failure so it can be diagnosed without a rerun. */
    getDiagnostics(attemptId) {
        const jsonPath = path.join(this.diagnosticsDir, `${attemptId}.json`);
        if (!fs.existsSync(jsonPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        } catch {
            return null;
        }
    }

    getScreenshotPath(attemptId) {
        const p = path.join(this.diagnosticsDir, `${attemptId}.png`);
        return fs.existsSync(p) ? p : null;
    }
}

module.exports = { LoginService };
