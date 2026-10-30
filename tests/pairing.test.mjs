/**
 * Device identity, pairing codes and signed invites.
 *
 * These run against real WebCrypto: both "devices" generate genuine P-256 key
 * pairs, so the shared short authentication string and the invite signatures
 * are verified exactly as they are in a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// js/core/pairing.js imports the app config, which reads document at import.
globalThis.window = {
  location: {
    origin: "https://droply-files.vercel.app",
    hostname: "droply-files.vercel.app",
    protocol: "https:",
    pathname: "/",
    search: "",
  },
  isSecureContext: true,
  setTimeout,
  clearTimeout,
};
globalThis.document = { querySelector: () => null };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { loadDeviceIdentity, deviceIdFromPublicJwk, isValidDeviceId } = await import(
  pathToFileURL(path.join(ROOT, "js/core/device-identity.js")).href
);
const {
  PAIRING_CODE_PATTERN,
  PAIRING_TTL_MS,
  acceptPairingPeer,
  codeFromPairingText,
  createInvite,
  isValidPairingCode,
  normalizePairingCode,
  readPeer,
  verifyInvite,
} = await import(pathToFileURL(path.join(ROOT, "js/core/pairing.js")).href);
const { createMemoryStore } = await import(
  pathToFileURL(path.join(ROOT, "js/core/storage/store.js")).href
);

async function makeIdentity(name) {
  return loadDeviceIdentity({ store: createMemoryStore(), rename: name });
}

const code = "ABC234";

/** The public half a device sends to the Worker. */
function peerOf(identity) {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    deviceType: identity.deviceType,
    publicKey: identity.publicJwk,
    agreementKey: identity.agreementPublicJwk,
  };
}

test("an identity is stable across loads and exposes only public keys", async () => {
  const store = createMemoryStore();
  const first = await loadDeviceIdentity({ store, rename: "Laptop" });
  const second = await loadDeviceIdentity({ store });

  assert.equal(first.deviceId, second.deviceId);
  assert.equal(second.name, "Laptop");
  assert.match(first.deviceId, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(isValidDeviceId(first.deviceId), true);
  assert.equal(await deviceIdFromPublicJwk(first.publicJwk), first.deviceId);

  const stored = await store.get("device.identity.v1");
  assert.equal(stored.extractable, undefined, "no exported private material is stored");
  assert.equal(JSON.stringify(stored).includes("\"d\""), false, "no private exponent in storage");
  assert.equal(stored.privateKey.extractable, false);
  assert.equal(stored.agreementPrivateKey.extractable, false);
});

/* --------------------------------------------------------------------------
   The six-character code
   -------------------------------------------------------------------------- */

test("codes are six unambiguous characters, normalised from real input", () => {
  assert.equal(normalizePairingCode(" a7k9-p2 "), "A7K9P2");
  assert.equal(normalizePairingCode("A7K9 P2"), "A7K9P2");
  assert.equal(normalizePairingCode("x4m8b1"), "X4M8B1");

  assert.equal(isValidPairingCode("A7K9P2"), true);
  assert.equal(isValidPairingCode("a7k9p2"), true);
  assert.equal(PAIRING_CODE_PATTERN.test("D9F2K7"), true);

  // Ambiguous glyphs are never issued, and short or foreign codes are refused.
  assert.equal(isValidPairingCode("A7K9P0"), false);
  assert.equal(isValidPairingCode("A7K9PI"), false);
  assert.equal(isValidPairingCode("A7K9PO"), false);
  assert.equal(isValidPairingCode("ABC"), false);
  assert.equal(isValidPairingCode("https://example.com"), false);

  // Five minutes, not ten.
  assert.equal(PAIRING_TTL_MS, 5 * 60_000);
});

test("a code can be recovered from a URL, a bare code or pasted text", () => {
  assert.equal(codeFromPairingText("A7K9P2"), "A7K9P2");
  assert.equal(codeFromPairingText("a7k9 p2"), "A7K9P2");
  assert.equal(
    codeFromPairingText("https://droply-files.vercel.app/#pair=A7K9P2"),
    "A7K9P2",
  );
  assert.equal(codeFromPairingText("Pair with me: a7k9-p2"), "A7K9P2");
  assert.equal(codeFromPairingText("droply-pair:A7K9P2"), "A7K9P2");
  assert.equal(codeFromPairingText("https://example.com/"), "");
  assert.equal(codeFromPairingText("hello"), "");
});

/* --------------------------------------------------------------------------
   SAS and peer validation
   -------------------------------------------------------------------------- */

test("both devices derive the same short authentication string", async () => {
  const alpha = await makeIdentity("Alpha");
  const beta = await makeIdentity("Beta");

  const betaResult = await acceptPairingPeer(beta, peerOf(alpha));
  const alphaResult = await acceptPairingPeer(alpha, peerOf(beta));

  assert.match(betaResult.sas, /^\d{3} \d{3}$/);
  assert.equal(betaResult.sas, alphaResult.sas, "both screens must agree");

  assert.equal(betaResult.contact.deviceId, alpha.deviceId);
  assert.equal(alphaResult.contact.deviceId, beta.deviceId);
  assert.equal(betaResult.contact.publicKey.x, alpha.publicJwk.x);
});

test("a third device derives a different string, so a relay cannot fake a match", async () => {
  const alpha = await makeIdentity("Alpha");
  const beta = await makeIdentity("Beta");
  const mallory = await makeIdentity("Mallory");

  const real = await acceptPairingPeer(beta, peerOf(alpha));
  const intercepted = await acceptPairingPeer(mallory, peerOf(alpha));

  assert.notEqual(real.sas, intercepted.sas);
});

test("a pairing response is bound to the device id it claims", async () => {
  const alpha = await makeIdentity("Alpha");
  const beta = await makeIdentity("Beta");

  await assert.rejects(
    () => readPeer({ ...peerOf(beta), deviceId: alpha.deviceId }),
    /didn't match its device identity/,
  );
  await assert.rejects(() => readPeer({ ...peerOf(beta), publicKey: null }), /public key/);
  await assert.rejects(() => readPeer("nope"), /usable pairing details/);
});

test("redeeming your own code is refused", async () => {
  const alpha = await makeIdentity("Alpha");
  await assert.rejects(() => acceptPairingPeer(alpha, peerOf(alpha)), /own code/);
});

/* --------------------------------------------------------------------------
   Signed invites (the durable reconnection credential)
   -------------------------------------------------------------------------- */

test("a signed invite verifies only for the paired device's key", async () => {
  const alpha = await makeIdentity("Alpha");
  const beta = await makeIdentity("Beta");

  const invite = await createInvite(alpha, { to: "a".repeat(32), code });
  assert.equal(invite.fromDeviceId, alpha.deviceId);
  assert.equal(invite.code, code);

  assert.equal(await verifyInvite(alpha.publicJwk, invite), true);
  assert.equal(await verifyInvite(beta.publicJwk, invite), false, "another device cannot sign for Alpha");
});

test("a tampered invite, an old invite and a replayed target are rejected", async () => {
  const alpha = await makeIdentity("Alpha");
  const invite = await createInvite(alpha, { to: "a".repeat(32), code });

  assert.equal(await verifyInvite(alpha.publicJwk, { ...invite, code: "ZZZ999" }), false);
  assert.equal(await verifyInvite(alpha.publicJwk, { ...invite, to: "b".repeat(32) }), false);
  assert.equal(await verifyInvite(alpha.publicJwk, { ...invite, sig: "" }), false);

  const old = await createInvite(alpha, {
    to: "a".repeat(32),
    code,
    issuedAt: Date.now() - 60 * 60_000,
  });
  assert.equal(await verifyInvite(alpha.publicJwk, old), false, "stale invites are not accepted");
});

test("device renaming is bounded and persisted", async () => {
  const store = createMemoryStore();
  const identity = await loadDeviceIdentity({ store, rename: "Laptop" });
  await identity.rename("  x".repeat(20));

  assert.equal(identity.name.length, 40);
  const reloaded = await loadDeviceIdentity({ store });
  assert.equal(reloaded.name, identity.name);
  await assert.rejects(() => identity.rename("   "), /Choose a device name/);
});
