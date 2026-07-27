/**
 * File: src/login/AccountStore.js
 * Description: Credentials and proxy bindings for accounts the login queue can
 *              refresh. Kept beside the auth files on the same volume; the
 *              login service is the only writer, so a plain JSON file is enough.
 *
 * Storage is deliberately separate from `configs/auth/auth-N.json`: those hold
 * a *session* (cookies, disposable, rewritten on every login), these hold the
 * *identity* (password, TOTP seed, proxy) that mints one.
 */

const fs = require("fs");
const path = require("path");

// Longest first: "----" must win before "--" would ever match a substring.
const SEPARATORS = ["----", "———", "——", "—", "\t", "|||", "||", "|"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Base32, 16+ chars — long enough not to collide with a password.
const TOTP_RE = /^[A-Z2-7]{16,}$/i;

class AccountStore {
    constructor(filePath, logger) {
        this.filePath = filePath || path.join(process.cwd(), "configs", "accounts.json");
        this.logger = logger;
        this.accounts = new Map(); // email -> record
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                this.accounts = new Map();
                return;
            }
            const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            const rows = Array.isArray(raw) ? raw : raw.accounts || [];
            this.accounts = new Map(rows.filter(r => r && r.email).map(r => [r.email.toLowerCase(), r]));
            this.logger?.info(`[Accounts] Loaded ${this.accounts.size} account(s) from ${this.filePath}`);
        } catch (err) {
            // Refuse to start from a half-parsed file: silently continuing with
            // an empty store would let a later save wipe every credential.
            throw new Error(`Failed to read ${this.filePath}: ${err.message}`);
        }
    }

    save() {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify([...this.accounts.values()], null, 2), "utf8");
        fs.renameSync(tmp, this.filePath); // atomic: never leave a truncated file
    }

    all() {
        return [...this.accounts.values()];
    }

    get(email) {
        return this.accounts.get(String(email || "").toLowerCase()) || null;
    }

    upsert(record) {
        if (!record?.email || !EMAIL_RE.test(record.email)) return null;
        const key = record.email.toLowerCase();
        const merged = { ...(this.accounts.get(key) || {}), ...record, email: record.email };
        this.accounts.set(key, merged);
        return merged;
    }

    remove(email) {
        return this.accounts.delete(String(email || "").toLowerCase());
    }

    /** Record what happened on the last login attempt, for the UI and the queue. */
    markAttempt(email, { ok, stage, error, attemptId }) {
        const rec = this.get(email);
        if (!rec) return null;
        rec.last_attempt_at = Date.now();
        rec.last_stage = stage || "";
        rec.last_attempt_id = attemptId || "";
        if (ok) {
            rec.last_status = "success";
            rec.last_error = "";
            rec.consecutive_failures = 0;
            rec.last_login_at = Date.now();
        } else {
            rec.last_status = "failed";
            rec.last_error = String(error || stage || "").slice(0, 300);
            rec.consecutive_failures = (rec.consecutive_failures || 0) + 1;
        }
        this.save();
        return rec;
    }

    /**
     * Resolve an account's proxy into the shape Playwright wants.
     *
     * Authenticated SOCKS5 is downgraded to HTTP on purpose: Firefox cannot do
     * username/password over SOCKS5 and rejects the context outright, and
     * providers that speak SOCKS5 on a port almost always accept HTTP CONNECT
     * on the same one.
     */
    static toPlaywrightProxy(rec) {
        if (!rec?.proxy_host || !rec?.proxy_port) return null;
        const out = { server: `http://${rec.proxy_host}:${rec.proxy_port}` };
        if (rec.proxy_username) out.username = String(rec.proxy_username);
        if (rec.proxy_password) out.password = String(rec.proxy_password);
        return out;
    }

    /** Render the proxy as the URL line an auth file carries. */
    static toProxyLine(rec) {
        if (!rec?.proxy_host || !rec?.proxy_port) return "";
        const user = rec.proxy_username ? encodeURIComponent(rec.proxy_username) : "";
        const pass = rec.proxy_password ? encodeURIComponent(rec.proxy_password) : "";
        const auth = user || pass ? `${user}:${pass}@` : "";
        return `http://${auth}${rec.proxy_host}:${rec.proxy_port}`;
    }

    /**
     * Parse pasted credential lines.
     *
     * Field order after email+password varies by source, so fields are matched
     * by shape rather than position: an email is the recovery address, a long
     * base32 run is the TOTP seed. Anything else (OAuth refresh tokens, notes)
     * is ignored rather than misfiled.
     *
     *   user@gmail.com----pwd----recovery@x.com----BASE32SEED----1//0eXtra
     *
     * A trailing `@host:port:user:pass` field binds a proxy at import time.
     */
    static parseText(text) {
        const parsed = [];
        const skipped = [];
        for (const rawLine of String(text || "").split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;

            const parts = AccountStore._split(line);
            if (parts.length < 2 || !EMAIL_RE.test(parts[0]) || !parts[1]) {
                skipped.push(line.slice(0, 80));
                continue;
            }

            const rec = { email: parts[0], password: parts[1] };
            for (const field of parts.slice(2)) {
                if (!field) continue;
                if (!rec.recovery_email && EMAIL_RE.test(field)) {
                    rec.recovery_email = field;
                } else if (!rec.totp_secret && TOTP_RE.test(field.replace(/\s/g, ""))) {
                    rec.totp_secret = field.replace(/\s/g, "").toUpperCase();
                } else if (!rec.proxy_host && /^[\w.-]+:\d+(:.*)?$/.test(field)) {
                    const [host, port, user, pass] = field.split(":");
                    rec.proxy_host = host;
                    rec.proxy_port = Number(port);
                    if (user) rec.proxy_username = user;
                    if (pass) rec.proxy_password = pass;
                }
            }
            parsed.push(rec);
        }
        return { parsed, skipped };
    }

    static _split(line) {
        for (const sep of SEPARATORS) {
            if (!line.includes(sep)) continue;
            const parts = line.split(sep).map(p => p.trim());
            if (parts.length >= 2 && EMAIL_RE.test(parts[0])) return parts;
        }
        return [line];
    }
}

module.exports = { AccountStore };
