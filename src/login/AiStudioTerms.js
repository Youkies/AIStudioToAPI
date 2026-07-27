/**
 * File: src/login/AiStudioTerms.js
 * Description: Clears the AI Studio terms gate for a freshly logged-in account.
 *
 * An account that has never opened AI Studio is met with a "Welcome" gate
 * carrying a required acknowledgement. Until it is accepted, every model call
 * for that account answers 403 PERMISSION_DENIED even though its cookies are
 * perfectly valid — so publishing it would only occupy a rotation slot with an
 * account that can never serve a request.
 *
 * Ported from the desktop upload tool's google_aistudio.py, which learned these
 * selectors the hard way.
 */

const AISTUDIO_URL = "https://aistudio.google.com/";

// The gate's copy is localised, so the checkbox class is the reliable anchor
// and the English text is only a fallback signal.
const GATE_TEXT = "Welcome to AI Studio";

// Passed to page.evaluate as real functions rather than source strings: a
// string body is evaluated as an expression, so `() => {...}` came back as the
// function itself and every field read as undefined.
//
// These three run inside the page, not in Node — hence the browser globals.
/* eslint-env browser */
const readState = gateText => {
    const boxes = [...document.querySelectorAll("mat-checkbox.tos-option")];
    const body = document.body ? document.body.innerText || "" : "";
    return {
        gate: boxes.length > 0,
        gateText: body.includes(gateText),
        ready: !!document.querySelector("ms-prompt-input-wrapper, textarea, [contenteditable=true]"),
        // Gemini is not offered everywhere; an unsupported exit IP is bounced
        // to the "available regions" doc instead of the app.
        regionBlocked:
            location.href.includes("available-regions") ||
            location.href.includes("ai.google.dev/gemini-api/docs/available"),
        signinRedirect: location.href.includes("accounts.google.com"),
        url: location.href,
    };
};

const acceptGate = () => {
    const boxes = [...document.querySelectorAll("mat-checkbox.tos-option")];
    if (!boxes.length) return { err: "no_checkbox", ok: false };
    // [0] is the required acknowledgement; [1] opts into marketing mail — skip it.
    const first = boxes[0];
    const input = first.querySelector("input[type=checkbox]");
    if (!input) return { err: "no_input", ok: false };
    if (!input.checked) (first.querySelector("label") || input).click();
    return { checked: input.checked, count: boxes.length, ok: true };
};

const clickContinue = () => {
    const b = [...document.querySelectorAll("button")].find(x => (x.innerText || "").trim() === "Continue");
    if (!b) return { err: "no_button", ok: false };
    if (b.disabled) return { err: "button_disabled", ok: false };
    b.click();
    return { ok: true };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Open AI Studio and clear the terms gate if it is showing.
 *
 * Never throws for an expected outcome — the caller decides what a failure
 * means. Navigation is retried because a shared exit node occasionally serves
 * a one-off proxy error that succeeds moments later.
 *
 * @returns {Promise<{ok: boolean, stage: string, message?: string}>}
 *   stage is one of: already_accepted | accepted | region_blocked |
 *   signin_redirect | navigate_failed | accept_failed | continue_failed
 */
async function ensureTermsAccepted(page, { logger, attempts = 3, settleMs = 8000 } = {}) {
    let lastError = "";

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await page.goto(AISTUDIO_URL, { timeout: 60000, waitUntil: "domcontentloaded" });
        } catch (err) {
            lastError = String(err).slice(0, 160);
            logger?.debug?.(`[Terms] navigate attempt ${attempt}/${attempts} failed: ${lastError}`);
            await sleep(3000);
            continue;
        }

        // The app hydrates well after domcontentloaded; reading state too early
        // reports neither gate nor editor and looks like a navigation failure.
        await sleep(settleMs);
        // Default to an empty object rather than letting a read failure throw,
        // but surface why — swallowing it silently is how a evaluate() bug
        // showed up as "Cannot read properties of undefined".
        const state = await page.evaluate(readState, GATE_TEXT).catch(err => {
            logger?.warn?.(`[Terms] state read failed: ${String(err).slice(0, 140)}`);
            return {};
        });

        if (state.signinRedirect) return { message: state.url, ok: false, stage: "signin_redirect" };
        if (state.regionBlocked) return { message: state.url, ok: false, stage: "region_blocked" };

        if (state.ready && !state.gate) return { ok: true, stage: "already_accepted" };

        if (state.gate || state.gateText) {
            const accepted = await page.evaluate(acceptGate).catch(() => ({ err: "eval_failed", ok: false }));
            if (!accepted.ok) return { message: accepted.err, ok: false, stage: "accept_failed" };
            await sleep(700);

            const cont = await page.evaluate(clickContinue).catch(() => ({ err: "eval_failed", ok: false }));
            if (!cont.ok) return { message: cont.err, ok: false, stage: "continue_failed" };

            await sleep(5000);
            const after = await page.evaluate(readState, GATE_TEXT).catch(() => ({}));
            if (after.ready || !after.gate) return { ok: true, stage: "accepted" };
            return { message: after.url, ok: false, stage: "still_gated" };
        }

        lastError = `neither gate nor editor at ${state.url || "unknown"}`;
        await sleep(2000);
    }

    return { message: lastError, ok: false, stage: "navigate_failed" };
}

module.exports = { AISTUDIO_URL, ensureTermsAccepted };
