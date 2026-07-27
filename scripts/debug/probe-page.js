/**
 * File: scripts/debug/probe-page.js
 * Description: Open AI Studio with a published account's cookies and report what
 *              the page actually is — the answer to "the request went into the
 *              browser and never came back".
 *
 * Usage: node scripts/debug/probe-page.js [authIndex]
 */

const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");

// page.evaluate callbacks run in the page, not in Node.
/* eslint-env browser */

const AUTH_DIR = path.join(process.cwd(), "configs", "auth");

function parseProxy(line) {
    const m = /^https?:\/\/(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)$/.exec(line || "");
    if (!m) return undefined;
    const out = { server: `http://${m[3]}:${m[4]}` };
    if (m[1]) out.username = decodeURIComponent(m[1]);
    if (m[2]) out.password = decodeURIComponent(m[2]);
    return out;
}

(async () => {
    const index = process.argv[2] || "0";
    const file = path.join(AUTH_DIR, `auth-${index}.json`);
    const auth = JSON.parse(fs.readFileSync(file, "utf8"));
    const proxy = parseProxy(auth.proxy);

    console.log(`account: ${auth.accountName}`);
    console.log(`cookies: ${auth.cookies.length} | proxy: ${proxy ? proxy.server : "NONE"}`);

    const browser = await firefox.launch({
        executablePath: process.env.CAMOUFOX_EXECUTABLE_PATH || path.join(process.cwd(), "camoufox-linux", "camoufox"),
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

        // Confirm the proxy is the one carried in the auth file before judging
        // anything about the page: a silently bypassed proxy would explain a
        // rejected session all on its own.
        try {
            await page.goto("https://api.ipify.org?format=json", { timeout: 45000 });
            console.log(`exit IP: ${(await page.innerText("body")).slice(0, 60)}`);
        } catch (err) {
            console.log(`exit IP: unreachable (${String(err).slice(0, 80)})`);
        }

        await page.goto("https://aistudio.google.com/", { timeout: 90000, waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 12000));

        console.log(`URL: ${page.url()}`);
        console.log(`TITLE: ${await page.title()}`);

        const state = await page.evaluate(() => ({
            body: (document.body ? document.body.innerText : "").slice(0, 400).replace(/\n/g, " | "),
            editor: !!document.querySelector("ms-prompt-input-wrapper, textarea, [contenteditable=true]"),
            gate: document.querySelectorAll("mat-checkbox.tos-option").length,
            runButton: [...document.querySelectorAll("button")].filter(b => /run|submit/i.test(b.innerText || ""))
                .length,
        }));
        console.log(`gate=${state.gate} editor=${state.editor} runButtons=${state.runButton}`);
        console.log(`BODY: ${state.body}`);
    } catch (err) {
        console.log(`ERR ${String(err).slice(0, 300)}`);
    } finally {
        await browser.close();
    }
    console.log("DONE");
})();
