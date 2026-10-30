/**
 * Guards the runtime configuration: the shipped build must talk to the
 * production signaling Worker, over https/wss, and local development must
 * still resolve to the local Worker.
 *
 * `js/config.js` reads the <meta> tags in index.html, so the tests parse the
 * real shipped file instead of duplicating its values.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const PROD_WORKER = "https://droply-signaling.alshahriarsayon425.workers.dev";
const PROD_SITE = "https://droply-files.vercel.app";
const CONFIG_URL = pathToFileURL(path.join(ROOT, "js/config.js")).href;

/** Reads a <meta name="..."> value out of index.html. */
function metaContent(name) {
  const match = INDEX.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`));
  return match ? match[1] : null;
}

/** The <meta> values the shipped index.html actually contains. */
const SHIPPED = {
  "droply-signaling": metaContent("droply-signaling"),
  "droply-turn-url": metaContent("droply-turn-url"),
  "droply-turn-username": metaContent("droply-turn-username"),
  "droply-turn-credential": metaContent("droply-turn-credential"),
};

let caseId = 0;

/**
 * Loads js/config.js with a stubbed window/document.
 * @param {{ origin: string, hostname?: string, search?: string, meta?: Record<string, string> }} location
 */
async function loadConfig(location) {
  const hostname = location.hostname ?? new URL(location.origin).hostname;
  const meta = { ...SHIPPED, ...(location.meta ?? {}) };
  globalThis.window = {
    location: {
      origin: location.origin,
      hostname,
      protocol: new URL(location.origin).protocol,
      pathname: "/",
      search: location.search ?? "",
    },
    isSecureContext: !location.origin.startsWith("http://"),
    setTimeout,
    clearTimeout,
  };
  globalThis.document = {
    querySelector(selector) {
      const match = selector.match(/meta\[name="([^"]+)"\]/);
      if (!match || !(match[1] in meta)) return null;
      return { getAttribute: () => meta[match[1]] };
    },
  };
  caseId += 1;
  return import(`${CONFIG_URL}?case=${caseId}`);
}

test("index.html ships the production signaling endpoint", () => {
  assert.equal(SHIPPED["droply-signaling"], PROD_WORKER);
  assert.equal(SHIPPED["droply-turn-url"], "", "no TURN relay is configured by default");
});

test("production resolves to the deployed Worker over https and wss", async () => {
  const { config, signalingUrl, signalingSocketUrl } = await loadConfig({ origin: PROD_SITE });
  assert.equal(config.signalingBaseUrl, PROD_WORKER);
  assert.equal(signalingUrl("/api/rooms"), `${PROD_WORKER}/api/rooms`);
  assert.equal(
    signalingSocketUrl("ABC234", "t0ken"),
    "wss://droply-signaling.alshahriarsayon425.workers.dev/api/rooms/ABC234/socket?token=t0ken",
  );
});

test("localhost uses the local Worker, not the deployed one", async () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:4173"]) {
    const { config, signalingSocketUrl } = await loadConfig({ origin });
    const host = new URL(origin).hostname;
    assert.equal(config.signalingBaseUrl, `http://${host}:8787`);
    assert.match(signalingSocketUrl("ABC234", "t"), /^ws:\/\/[^/]+:8787\/api\/rooms\/ABC234\/socket\?token=t$/);
  }
});

test("a local meta tag wins over the 8787 default", async () => {
  // The browser test harness serves the page from a local port while pointing
  // it at an isolated local Worker.
  const { config, signalingSocketUrl } = await loadConfig({
    origin: "http://127.0.0.1:8789",
    meta: { "droply-signaling": "http://127.0.0.1:8788" },
  });
  assert.equal(config.signalingBaseUrl, "http://127.0.0.1:8788");
  assert.match(signalingSocketUrl("ABC234", "t"), /^ws:\/\/127\.0\.0\.1:8788\//);
});

test("?signaling= overrides the configured endpoint", async () => {
  const { config } = await loadConfig({
    origin: PROD_SITE,
    search: "?signaling=http://127.0.0.1:9999/",
  });
  assert.equal(config.signalingBaseUrl, "http://127.0.0.1:9999");
});

test("non-http override values are ignored", async () => {
  for (const search of ["?signaling=javascript:alert(1)", "?signaling=//evil.example"]) {
    const { config } = await loadConfig({ origin: PROD_SITE, search });
    assert.equal(config.signalingBaseUrl, PROD_WORKER);
  }
});

test("an empty meta tag means same origin", async () => {
  const { config, signalingUrl, signalingSocketUrl } = await loadConfig({
    origin: PROD_SITE,
    meta: { "droply-signaling": "" },
  });
  assert.equal(config.signalingBaseUrl, "");
  assert.equal(signalingUrl("/api/rooms"), "/api/rooms");
  assert.match(signalingSocketUrl("ABC234", "t"), /^wss:\/\/droply-files\.vercel\.app\/api\/rooms\/ABC234\/socket/);
});

test("ICE configuration is STUN-only until TURN credentials are supplied", async () => {
  const { config } = await loadConfig({ origin: PROD_SITE });
  assert.ok(config.iceServers.length >= 1);
  assert.ok(config.iceServers[0].urls.some((url) => url.startsWith("stun:")));
  assert.equal(
    config.iceServers.filter((server) => [server.urls ?? []].flat().some((url) => String(url).startsWith("turn"))).length,
    0,
    "an unconfigured TURN server would make WebRTC fail on startup",
  );
});

test("TURN credentials from meta tags are passed through unchanged", async () => {
  const { config } = await loadConfig({
    origin: PROD_SITE,
    meta: {
      "droply-turn-url": "turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349",
      "droply-turn-username": "user",
      "droply-turn-credential": "secret",
    },
  });
  const turn = config.iceServers.find((server) => String(server.urls).includes("turn"));
  assert.ok(turn, "TURN server should be configured");
  assert.deepEqual(turn.urls, ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"]);
  assert.equal(turn.username, "user");
  assert.equal(turn.credential, "secret");
});
