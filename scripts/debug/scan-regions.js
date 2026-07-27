/**
 * Which published accounts can actually reach AI Studio?
 *
 * A blocked exit IP lands on the "available regions" doc instead of the app,
 * which looks identical to a hung request from the outside: the page never
 * becomes something that can answer.
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
    const files = fs
        .readdirSync(AUTH_DIR)
        .filter(f => /^auth-\d+\.json$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const out = fs.createWriteStream("scan-regions.log");
    const w = s => {
        console.log(s);
        out.write(s + "\n");
    };

    const tally = { blocked: [], error: [], ok: [] };
    for (const f of files) {
        const auth = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, f), "utf8"));
        const proxy = parseProxy(auth.proxy);
        let browser = null;
        try {
            browser = await firefox.launch({
                executablePath: EXE,
                firefoxUserPrefs: { "network.trr.mode": 5 },
                headless: true,
                ...(proxy ? { proxy } : {}),
            });
            const ctx = await browser.newContext({
                storageState: { cookies: auth.cookies, origins: auth.origins || [] },
                viewport: null,
            });
            const page = await ctx.newPage();
            page.setDefaultTimeout(45000);
            await page.goto("https://aistudio.google.com/", { timeout: 60000, waitUntil: "domcontentloaded" });
            await new Promise(r => setTimeout(r, 8000));
            const url = page.url();
            const ready = await page
                .evaluate(() => !!document.querySelector("ms-prompt-input-wrapper, textarea, [contenteditable=true]"))
                .catch(() => false);
            const blocked = /available-regions|available_regions/.test(url);
            const bucket = blocked ? "blocked" : ready ? "ok" : "error";
            tally[bucket].push(auth.accountName);
            w(
                `${bucket === "ok" ? "✅" : blocked ? "🚫" : "⚠️ "} ${f.padEnd(13)} ${String(auth.accountName).slice(0, 32).padEnd(33)} ${proxy ? proxy.server.replace("http://", "") : "no-proxy"}  ${blocked ? "REGION BLOCKED" : ready ? "ready" : url.slice(0, 60)}`
            );
        } catch (err) {
            tally.error.push(auth.accountName);
            w(
                `⚠️  ${f.padEnd(13)} ${String(auth.accountName).slice(0, 32).padEnd(33)} ERR ${String(err).slice(0, 60)}`
            );
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }
    w(`\n=== 可用 ${tally.ok.length} | 地区受限 ${tally.blocked.length} | 异常 ${tally.error.length} ===`);
    if (tally.blocked.length) w("地区受限: " + tally.blocked.join(", "));
    if (tally.error.length) w("异常: " + tally.error.join(", "));
    out.end();
    console.log("DONE");
})();
