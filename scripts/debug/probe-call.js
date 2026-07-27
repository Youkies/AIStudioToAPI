/**
 * File: scripts/debug/probe-call.js
 * Description: Drive one real generateContent call inside the page, the way the
 *              injected client does, and report where it stops.
 *
 * The service logs a clean route and then nothing: this narrows "the browser
 * swallowed it" down to a specific HTTP status from Google.
 */
const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");

// page.evaluate callbacks run in the page, not in Node.
/* eslint-env browser */

const AUTH_DIR = path.join(process.cwd(), "configs", "auth");
const EXE = process.env.CAMOUFOX_EXECUTABLE_PATH || path.join(process.cwd(), "camoufox-linux", "camoufox");

function parseProxy(line) {
    const m = /^https?:\/\/(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)$/.exec(line || "");
    if (!m) return undefined;
    const out = { server: `http://${m[3]}:${m[4]}` };
    if (m[1]) out.username = decodeURIComponent(m[1]);
    if (m[2]) out.password = decodeURIComponent(m[2]);
    return out;
}

(async () => {
    const index = process.argv[2] || "1";
    const model = process.argv[3] || "gemini-2.5-pro";
    const auth = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, `auth-${index}.json`), "utf8"));
    const proxy = parseProxy(auth.proxy);
    console.log(`account: ${auth.accountName} | proxy: ${proxy ? proxy.server : "NONE"}`);

    const browser = await firefox.launch({
        executablePath: EXE,
        firefoxUserPrefs: { "network.trr.mode": 5 },
        headless: true,
        ...(proxy ? { proxy } : {}),
    });
    try {
        const ctx = await browser.newContext({
            storageState: { cookies: auth.cookies, origins: auth.origins || [] },
            viewport: null,
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(60000);
        await page.goto("https://aistudio.google.com/", { timeout: 90000, waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 10000));
        console.log(`page: ${page.url()}`);

        // Same endpoint the injected client hits, issued from the page so it
        // carries the session exactly as the real path would.
        const result = await page.evaluate(async m => {
            const started = Date.now();
            try {
                const res = await fetch(`/v1beta/models/${m}:generateContent`, {
                    body: JSON.stringify({ contents: [{ parts: [{ text: "say ok" }], role: "user" }] }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                });
                const text = await res.text();
                return { elapsed: Date.now() - started, ok: res.ok, snippet: text.slice(0, 300), status: res.status };
            } catch (err) {
                return { elapsed: Date.now() - started, error: String(err).slice(0, 200) };
            }
        }, model);

        console.log(
            `call: status=${result.status ?? "-"} ok=${result.ok ?? "-"} ${(result.elapsed / 1000).toFixed(1)}s`
        );
        if (result.error) console.log(`error: ${result.error}`);
        if (result.snippet) console.log(`body: ${result.snippet.replace(/\n/g, " ")}`);
    } catch (err) {
        console.log(`ERR ${String(err).slice(0, 300)}`);
    } finally {
        await browser.close();
    }
    console.log("DONE");
})();
