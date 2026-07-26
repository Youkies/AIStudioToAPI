/**
 * File: src/utils/ProxyUtils.js
 * Description: Utility functions for parsing proxy configuration from environment variables
 *
 * Author: iBenzene, bbbugg
 */

const PROXY_SERVER_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"];
const DEFAULT_BYPASS = ["localhost", "127.0.0.1", "::", "::1", "0.0.0.0"];

const _getFirstEnvValue = envKeys => {
    const envKey = envKeys.find(key => process.env[key] && String(process.env[key]).trim());
    return envKey
        ? {
              envKey,
              value: String(process.env[envKey]).trim(),
          }
        : null;
};

const _getProxyServerEnv = () => _getFirstEnvValue(PROXY_SERVER_ENV_KEYS);

const _getBypassEntries = () => {
    const bypassEnv = _getFirstEnvValue(NO_PROXY_ENV_KEYS);
    const userBypass = bypassEnv
        ? bypassEnv.value
              .split(",")
              .map(s => s.trim())
              .filter(Boolean)
        : [];

    return [...new Set([...DEFAULT_BYPASS, ...userBypass])];
};

const getProxyBypassFromEnv = () => _getBypassEntries().join(",");

// Redact credentials in proxy strings, without needing valid URL parsing.
// - `scheme://user:pass@host` -> `scheme://***@host`
// - `user:pass@host:port` -> `***@host:port`
const _redactProxyCredentials = serverRaw => {
    const raw = String(serverRaw);
    const withScheme = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]+)@/i, "$1***@");
    if (withScheme !== raw) return withScheme;
    return raw.replace(/^([^@/]+)@/, "***@");
};

/**
 * Parse proxy configuration from environment variables
 * Supports HTTPS_PROXY, HTTP_PROXY, ALL_PROXY and their lowercase variants
 * Also supports NO_PROXY for bypass rules
 *
 * @returns {Object|null} Proxy config object for Playwright, or null if no proxy configured
 * @example
 * // Returns: { server: "http://127.0.0.1:7890", bypass: "localhost,127.0.0.1" }
 * // Or with auth: { server: "http://proxy.com:8080", username: "user", password: "pass" }
 */
const parseProxyFromEnv = () => {
    const proxyEnv = _getProxyServerEnv();
    if (!proxyEnv) return null;

    const bypass = getProxyBypassFromEnv();

    // Playwright expects: { server, bypass?, username?, password? }
    // server examples: "http://127.0.0.1:7890", "socks5://127.0.0.1:7890"
    try {
        const u = new URL(proxyEnv.value);
        const proxy = {
            bypass,
            server: `${u.protocol}//${u.host}`,
        };

        if (u.username) proxy.username = decodeURIComponent(u.username);
        if (u.password) proxy.password = decodeURIComponent(u.password);

        return proxy;
    } catch {
        // If URL parsing fails, use raw value directly
        return {
            bypass,
            server: proxyEnv.value,
        };
    }
};

/**
 * Get a safe summary of proxy configuration from environment variables.
 * This is intended for logging/UI display and avoids leaking credentials.
 *
 * @returns {{enabled: boolean, envKey?: string, server?: string}}
 */
const getProxySummaryFromEnv = () => {
    const proxyEnv = _getProxyServerEnv();
    if (!proxyEnv) return { enabled: false };

    const serverRaw = proxyEnv.value;

    try {
        const u = new URL(serverRaw);
        return {
            enabled: true,
            envKey: proxyEnv.envKey,
            server: `${u.protocol}//${u.host}`,
        };
    } catch {
        // If URL parsing fails, at least redact obvious `user:pass@` patterns
        return {
            enabled: true,
            envKey: proxyEnv.envKey,
            server: _redactProxyCredentials(serverRaw),
        };
    }
};

/**
 * Parse the proxy an auth file carries for its own account.
 *
 * A Google session cookie is bound to the IP that minted it: replay it from a
 * different network and Google voids it within hours. The uploader therefore
 * records the proxy it logged in through inside the auth file, so this server
 * browses as the same exit IP. Changing an account's proxy is then just a
 * re-upload — no server-side list or mapping to keep in sync.
 *
 * Accepted shapes for `auth.proxy`:
 *   "http://user:pass@host:port"          (string, any scheme)
 *   "host:port:user:pass"                 (string, colon dump)
 *   { server, username?, password? }      (object, Playwright-native)
 *
 * @param {Object} auth Parsed auth file contents
 * @returns {Object|null} Playwright proxy config, or null when absent/unusable
 */
const parseProxyFromAuth = auth => {
    const raw = auth?.proxy;
    if (!raw) return null;

    const bypass = getProxyBypassFromEnv();

    if (typeof raw === "object") {
        if (!raw.server) return null;
        const proxy = { bypass, server: String(raw.server) };
        if (raw.username) proxy.username = String(raw.username);
        if (raw.password) proxy.password = String(raw.password);
        return proxy;
    }

    const line = String(raw).trim();
    if (!line) return null;

    // Scheme form. socks5h is curl-only spelling — Firefox rejects it, and the
    // difference (proxy-side DNS) is what socks5 does here anyway.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        try {
            const u = new URL(line);
            if (!u.hostname || !u.port) return null;
            const scheme = u.protocol === "socks5h:" ? "socks5:" : u.protocol;
            const proxy = { bypass, server: `${scheme}//${u.hostname}:${u.port}` };
            if (u.username) proxy.username = decodeURIComponent(u.username);
            if (u.password) proxy.password = decodeURIComponent(u.password);
            return proxy;
        } catch {
            return null;
        }
    }

    // user:pass@host:port
    if (line.includes("@")) {
        const at = line.lastIndexOf("@");
        const auth_ = line.slice(0, at);
        const addr = line.slice(at + 1);
        const sep = auth_.indexOf(":");
        const [host, port] = addr.split(":");
        if (sep === -1 || !host || !port) return null;
        return {
            bypass,
            password: auth_.slice(sep + 1),
            server: `http://${host}:${port}`,
            username: auth_.slice(0, sep),
        };
    }

    // host:port[:user:pass]
    const parts = line.split(":");
    if (parts.length === 4) {
        const [host, port, username, password] = parts;
        if (!host || !port) return null;
        return { bypass, password, server: `http://${host}:${port}`, username };
    }
    if (parts.length === 2 && parts[0] && parts[1]) {
        return { bypass, server: `http://${parts[0]}:${parts[1]}` };
    }
    return null;
};

/**
 * Render a proxy config for logs without leaking credentials.
 * @param {Object} proxy Playwright proxy config
 * @returns {string}
 */
const redactProxyServer = proxy => {
    if (!proxy?.server) return "N/A";
    return proxy.username ? `${_redactProxyCredentials(proxy.server)} (auth)` : String(proxy.server);
};

module.exports = {
    getProxyBypassFromEnv,
    getProxySummaryFromEnv,
    parseProxyFromAuth,
    parseProxyFromEnv,
    redactProxyServer,
};
