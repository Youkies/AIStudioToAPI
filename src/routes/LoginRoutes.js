/**
 * File: src/routes/LoginRoutes.js
 * Description: HTTP surface for the credential store, the login queue and the
 *              diagnostics a failed attempt leaves behind.
 *
 * The diagnostics endpoints are read-only by design: they exist so a failure
 * can be understood from outside the container, without shelling in and
 * without re-running the attempt that produced it.
 */

const fs = require("fs");

class LoginRoutes {
    constructor(serverSystem) {
        this.serverSystem = serverSystem;
        this.logger = serverSystem.logger;
    }

    get service() {
        return this.serverSystem.loginService;
    }

    setupRoutes(app, isAuthenticated) {
        const guard = (req, res, next) => {
            if (!this.service) {
                return res.status(503).json({ error: "Login service is not enabled" });
            }
            return next();
        };

        // SPA entry: routes are registered one by one here rather than by a
        // catch-all, so a new page needs its own line or it 404s on refresh.
        app.get("/accounts", isAuthenticated, (req, res) => {
            res.sendFile(this.serverSystem.distIndexPath);
        });

        // --- accounts -------------------------------------------------------

        app.get("/api/login/accounts", isAuthenticated, guard, (req, res) => {
            // Never ship secrets to the browser: the UI needs to know a
            // credential exists, not what it is.
            const rows = this.service.store.all().map(r => ({
                auth_index: r.auth_index,
                consecutive_failures: r.consecutive_failures || 0,
                email: r.email,
                has_password: Boolean(r.password),
                has_totp: Boolean(r.totp_secret),
                last_attempt_at: r.last_attempt_at || 0,
                last_attempt_id: r.last_attempt_id || "",
                last_error: r.last_error || "",
                last_login_at: r.last_login_at || 0,
                last_stage: r.last_stage || "",
                last_status: r.last_status || "",
                proxy: r.proxy_host ? `${r.proxy_host}:${r.proxy_port}` : "",
                published_at: r.published_at || 0,
                recovery_email: r.recovery_email || "",
                // Absent means the account predates the terms step — treat that
                // as "not cleared" rather than "fine", or every account logged
                // in before the fix reports healthy while answering 403.
                terms_ok: r.terms_ok === true,
                terms_stage: r.terms_stage || "",
            }));
            res.json({ accounts: rows, total: rows.length });
        });

        app.post("/api/login/accounts/import", isAuthenticated, guard, (req, res) => {
            const { text } = req.body || {};
            if (!text || typeof text !== "string") {
                return res.status(400).json({ error: "Missing text" });
            }
            try {
                res.json(this.service.importText(text));
            } catch (err) {
                this.logger.error(`[LoginRoutes] Import failed: ${err.message}`);
                res.status(500).json({ error: err.message });
            }
        });

        app.put("/api/login/accounts/:email", isAuthenticated, guard, (req, res) => {
            const email = decodeURIComponent(req.params.email);
            if (!this.service.store.get(email)) {
                return res.status(404).json({ error: "Account not found" });
            }
            // Whitelist: an open merge would let the UI overwrite bookkeeping
            // fields like auth_index and desynchronise the store from disk.
            const allowed = [
                "password",
                "proxy_host",
                "proxy_password",
                "proxy_port",
                "proxy_username",
                "recovery_email",
                "totp_secret",
            ];
            const patch = { email };
            for (const key of allowed) {
                if (key in (req.body || {})) patch[key] = req.body[key];
            }
            const updated = this.service.store.upsert(patch);
            this.service.store.save();
            res.json({ email: updated.email, ok: true });
        });

        app.delete("/api/login/accounts/:email", isAuthenticated, guard, (req, res) => {
            const email = decodeURIComponent(req.params.email);
            const removed = this.service.store.remove(email);
            if (removed) this.service.store.save();
            res.json({ ok: removed });
        });

        // --- queue ----------------------------------------------------------

        app.get("/api/login/queue", isAuthenticated, guard, (req, res) => {
            res.json(this.service.queue.status());
        });

        app.post("/api/login/queue/enqueue", isAuthenticated, guard, (req, res) => {
            const { emails, priority, reason } = req.body || {};
            if (!Array.isArray(emails) || !emails.length) {
                return res.status(400).json({ error: "emails required" });
            }
            const known = emails.filter(e => this.service.store.get(e));
            const unknown = emails.filter(e => !this.service.store.get(e));
            const added = this.service.queue.enqueue(known, {
                priority: Boolean(priority),
                reason: reason || "manual",
            });
            res.json({ added, skipped: known.filter(e => !added.includes(e)), unknown });
        });

        app.post("/api/login/queue/control", isAuthenticated, guard, (req, res) => {
            const { action, email } = req.body || {};
            const q = this.service.queue;
            switch (action) {
                case "start":
                    q.start();
                    break;
                case "pause":
                    q.pause("manual");
                    break;
                case "clear":
                    return res.json({ dropped: q.clear(), ok: true });
                case "promote":
                    return res.json({ ok: q.promote(email) });
                case "dequeue":
                    return res.json({ ok: q.dequeue(email) });
                default:
                    return res.status(400).json({ error: "unknown action" });
            }
            res.json({ ok: true, status: q.status() });
        });

        app.put("/api/login/queue/settings", isAuthenticated, guard, (req, res) => {
            res.json({ ok: true, settings: this.service.queue.updateSettings(req.body || {}) });
        });

        // --- diagnostics (read-only) ----------------------------------------

        app.get("/api/login/attempts/:attemptId", isAuthenticated, guard, (req, res) => {
            const data = this.service.getDiagnostics(req.params.attemptId);
            if (!data) return res.status(404).json({ error: "No diagnostics for this attempt" });
            res.json(data);
        });

        app.get("/api/login/attempts/:attemptId/screenshot", isAuthenticated, guard, (req, res) => {
            const file = this.service.getScreenshotPath(req.params.attemptId);
            if (!file) return res.status(404).json({ error: "No screenshot for this attempt" });
            res.type("png").send(fs.readFileSync(file));
        });

        this.logger.info("[LoginRoutes] Login management routes registered.");
    }
}

module.exports = LoginRoutes;
