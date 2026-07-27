/**
 * File: src/login/GoogleLogin.js
 * Description: Drives a Google credential login inside Camoufox and returns the
 *              resulting storageState, so an expired account can be refreshed
 *              without a human at a browser.
 *
 * The flow is deliberately defensive about Google's markup: the same step is
 * served with different DOM on different builds, and the sign-in panel animates
 * in while its inputs already resolve. Both cost us a full run each during
 * bring-up, so every field lookup probes a list and every click can fall back.
 */

const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { firefox } = require("playwright");

const SIGNIN_URL = "https://accounts.google.com/signin";
const MYACCOUNT_URL = "https://myaccount.google.com/";

// Mirrors BrowserManager: DoH off so the system resolver — and therefore the
// per-account proxy — is what actually resolves names.
const FIREFOX_PREFS = {
    "app.shield.optoutstudies.enabled": false,
    "datareporting.healthreport.uploadEnabled": false,
    "network.dns.disablePrefetch": true,
    "network.trr.mode": 5,
    "services.sync.enabled": false,
};

const EMAIL_SELECTORS = ["input[type='email']", "#identifierId", "input[name='identifier']"];
const PASSWORD_SELECTORS = ["input[type='password']", "input[name='Passwd']"];
const TOTP_SELECTORS = ["input[name='totpPin']", "#totpPin", "input[type='tel']"];
const DISMISS_LABELS = ["Not now", "Not Now", "No thanks", "以后再说", "暂时不用", "Skip"];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** RFC 6238 TOTP. Inlined so the login path adds no runtime dependency. */
function totpNow(secret) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const ch of String(secret).replace(/[\s=]/g, "").toUpperCase()) {
        const v = alphabet.indexOf(ch);
        if (v >= 0) bits += v.toString(2).padStart(5, "0");
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));

    const counter = Math.floor(Date.now() / 30000);
    const msg = Buffer.alloc(8);
    msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    msg.writeUInt32BE(counter >>> 0, 4);

    const hmac = crypto.createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(code % 1e6).padStart(6, "0");
}

class GoogleLogin {
    /**
     * @param {object} opts
     * @param {object} opts.logger
     * @param {string} [opts.executablePath] - Camoufox binary; auto-detected per platform.
     * @param {string} [opts.diagnosticsDir] - Where failure screenshots land.
     * @param {boolean} [opts.headless]
     * @param {number} [opts.timeoutMs] - Whole-attempt budget; the browser is killed past it.
     */
    constructor({ logger, executablePath, diagnosticsDir, headless = true, timeoutMs = 300000 }) {
        this.logger = logger;
        this.executablePath = executablePath || GoogleLogin.resolveBrowserPath();
        this.diagnosticsDir = diagnosticsDir || path.join(process.cwd(), "data", "login-diagnostics");
        this.headless = headless;
        this.timeoutMs = timeoutMs;
    }

    static resolveBrowserPath() {
        // Same env var BrowserManager honours, so one setting moves both.
        if (process.env.CAMOUFOX_EXECUTABLE_PATH) return process.env.CAMOUFOX_EXECUTABLE_PATH;

        const platform = os.platform();
        if (platform === "linux") return path.join(process.cwd(), "camoufox-linux", "camoufox");
        if (platform === "win32") return path.join(process.cwd(), "camoufox", "camoufox.exe");
        if (platform === "darwin") {
            return path.join(process.cwd(), "camoufox-macos", "Camoufox.app", "Contents", "MacOS", "camoufox");
        }
        throw new Error(`Unsupported operating system: ${platform}`);
    }

    /**
     * Log one account in.
     *
     * @param {object} account - { email, password, totp_secret, proxy }
     * @param {object} [opts]
     * @param {string} [opts.attemptId] - Groups diagnostics for this attempt.
     * @param {function} [opts.onStage] - Called as (stage, url) for live progress.
     * @returns {Promise<object>} { ok, stage, cookies?, storageState?, diagnostics? }
     */
    async login(account, { attemptId, onStage } = {}) {
        const id = attemptId || `${account.email.split("@")[0]}-${Date.now()}`;
        const stage = { current: "launch" };
        // Per-stage timings: when a batch is slower than a single run, this is
        // what says whether it is the proxy, Google, or our own waits.
        const timings = {};
        let lastMark = Date.now();
        const note = (s, page) => {
            timings[stage.current] = (timings[stage.current] || 0) + (Date.now() - lastMark);
            lastMark = Date.now();
            stage.current = s;
            if (onStage) onStage(s, page ? page.url() : "");
        };

        let browser = null;
        let killTimer = null;
        try {
            browser = await this._launch(account.proxy);

            // Hard stop: a hung page must not hold a browser (and its ~400MB)
            // forever. Closing here makes the awaiting call reject and unwind.
            killTimer = setTimeout(() => {
                this.logger.warn(
                    `[Login] ${account.email} exceeded ${this.timeoutMs}ms at stage ${stage.current}; killing browser.`
                );
                browser.close().catch(() => {});
            }, this.timeoutMs);

            const ctx = await browser.newContext({ viewport: null });
            const page = await ctx.newPage();
            page.setDefaultTimeout(60000);

            note("signin", page);
            await page.goto(SIGNIN_URL, { timeout: 90000, waitUntil: "domcontentloaded" });
            await sleep(3500);

            const emailSel = await this._firstVisible(page, EMAIL_SELECTORS, 40000);
            if (!emailSel) return await this._fail(page, id, "email_input_missing", stage);
            note("email", page);
            await this._type(page, emailSel, account.email);
            await page.keyboard.press("Enter");
            await sleep(6000);

            const pwdSel = await this._firstVisible(page, PASSWORD_SELECTORS, 30000);
            if (!pwdSel) return await this._fail(page, id, "password_prompt_missing", stage);
            note("password", page);
            await this._type(page, pwdSel, account.password);
            await page.keyboard.press("Enter");
            await sleep(9000);

            if (account.totp_secret) {
                const totpSel = await this._firstVisible(page, TOTP_SELECTORS, 20000);
                if (totpSel) {
                    note("totp", page);
                    await this._type(page, totpSel, totpNow(account.totp_secret));
                    await page.keyboard.press("Enter");
                    await sleep(9000);
                }
            }

            note("speedbump", page);
            await this._dismissSpeedbumps(page);

            note("verify", page);
            const landed = page.url();
            if (!GoogleLogin.isSignedIn(landed)) {
                try {
                    await page.goto(MYACCOUNT_URL, { timeout: 45000, waitUntil: "domcontentloaded" });
                    await sleep(2500);
                } catch {
                    /* keep whatever we have and let the check below decide */
                }
            }
            if (!GoogleLogin.isSignedIn(page.url())) {
                return await this._fail(page, id, "not_signed_in", stage, { landed });
            }

            const storageState = await ctx.storageState();
            // Guard the store: a plausible landing page with no session cookie
            // once overwrote a good cookie set with three junk ones.
            if (!GoogleLogin.hasSession(storageState.cookies)) {
                return await this._fail(page, id, "no_session_cookie", stage, {
                    cookieCount: storageState.cookies.length,
                });
            }

            note("done", page);
            const breakdown = Object.entries(timings)
                .map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`)
                .join(" ");
            this.logger.info(
                `✅ [Login] ${account.email} signed in (${storageState.cookies.length} cookies). ${breakdown}`
            );
            return {
                cookies: storageState.cookies,
                ok: true,
                stage: "done",
                storageState,
                timings,
            };
        } catch (err) {
            this.logger.warn(`[Login] ${account.email} failed at ${stage.current}: ${String(err).slice(0, 200)}`);
            return {
                error: String(err).slice(0, 400),
                ok: false,
                stage: stage.current,
            };
        } finally {
            if (killTimer) clearTimeout(killTimer);
            // Always close: an orphaned Camoufox survives the parent process and
            // keeps its memory. We leaked 16 of them during bring-up this way.
            if (browser) await browser.close().catch(() => {});
        }
    }

    async _launch(proxy) {
        // Camoufox occasionally dies during startup with no diagnostic. Retrying
        // beats reporting a flaky launch as a dead account.
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await firefox.launch({
                    executablePath: this.executablePath,
                    firefoxUserPrefs: FIREFOX_PREFS,
                    headless: this.headless,
                    ...(proxy ? { proxy } : {}),
                });
            } catch (err) {
                lastErr = err;
                this.logger.warn(`[Login] Camoufox launch attempt ${attempt}/3 failed: ${String(err).slice(0, 140)}`);
                await sleep(3000);
            }
        }
        throw lastErr;
    }

    async _firstVisible(page, selectors, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            for (const sel of selectors) {
                try {
                    const loc = page.locator(sel).first();
                    if ((await loc.count()) && (await loc.isVisible())) return sel;
                } catch {
                    /* selector not usable yet */
                }
            }
            await sleep(400);
        }
        return null;
    }

    /**
     * Type into a field, keystroke by keystroke.
     *
     * The click is allowed to fail: Google re-renders the panel while it
     * animates, so a locator that just resolved can still fail the
     * actionability wait. Focusing via JS sidesteps that check entirely.
     */
    async _type(page, selector, text) {
        const loc = page.locator(selector).first();
        try {
            await loc.click({ timeout: 12000 });
        } catch {
            await page.$eval(selector, el => el.focus());
        }
        for (const ch of text) {
            await page.keyboard.type(ch);
            await sleep(50 + Math.random() * 110);
        }
    }

    /**
     * Clear the post-2FA speed bumps that stand between us and a session.
     *
     * Google ends a successful login on `speedbump/passkeyenrollment` ("Sign in
     * faster"), sometimes twice. Two traps live here:
     *   - the URL lags the rendered panel, so detection reads page text instead;
     *   - matching by text alone hits "Skip to main content", the a11y jump link
     *     present on myaccount, and clicks that instead. Buttons only.
     */
    async _dismissSpeedbumps(page, rounds = 4) {
        for (let i = 0; i < rounds; i++) {
            const body = await page.innerText("body").catch(() => "");
            if (!/passkey/i.test(body) && !/Sign in faster/i.test(body)) return;

            let clicked = false;
            for (const label of DISMISS_LABELS) {
                try {
                    const el = page.getByRole("button", { exact: false, name: label }).first();
                    if ((await el.count()) && (await el.isVisible())) {
                        await el.click();
                        await sleep(4000);
                        clicked = true;
                        break;
                    }
                } catch {
                    /* try the next label */
                }
            }
            if (!clicked) return;
        }
    }

    /** Capture what the page looked like so a failure can be diagnosed without a rerun. */
    async _fail(page, attemptId, reason, stage, extra = {}) {
        const diagnostics = { body: "", reason, selectors: {}, stage: stage.current, title: "", url: "", ...extra };
        try {
            diagnostics.url = page.url();
            diagnostics.title = await page.title().catch(() => "");
            diagnostics.body = (await page.innerText("body").catch(() => "")).slice(0, 800);
            for (const sel of [...EMAIL_SELECTORS, ...PASSWORD_SELECTORS, ...TOTP_SELECTORS]) {
                const loc = page.locator(sel).first();
                const count = await loc.count().catch(() => 0);
                diagnostics.selectors[sel] = {
                    count,
                    visible: count ? await loc.isVisible().catch(() => false) : false,
                };
            }
            fs.mkdirSync(this.diagnosticsDir, { recursive: true });
            const shot = path.join(this.diagnosticsDir, `${attemptId}.png`);
            await page.screenshot({ fullPage: false, path: shot });
            diagnostics.screenshot = path.basename(shot);
            fs.writeFileSync(
                path.join(this.diagnosticsDir, `${attemptId}.json`),
                JSON.stringify(diagnostics, null, 2),
                "utf8"
            );
        } catch (err) {
            this.logger.debug(`[Login] diagnostics capture failed: ${String(err).slice(0, 120)}`);
        }
        return { diagnostics, ok: false, stage: reason };
    }

    /**
     * `google.com/account/about/` is the marketing page a *rejected* session
     * lands on — counting it as success is how a failed login once looked like
     * a win.
     */
    static isSignedIn(url) {
        const u = String(url || "").toLowerCase();
        if (u.includes("signin") || u.includes("/account/about")) return false;
        return u.includes("myaccount.google.com");
    }

    static hasSession(cookies) {
        const names = new Set((cookies || []).map(c => c.name));
        return names.has("__Secure-1PSID") || names.has("SID");
    }
}

module.exports = { GoogleLogin, totpNow };
