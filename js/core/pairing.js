/**
 * Device pairing and authenticated transfer invites.
 *
 * Pairing uses a six-character, single-use code issued by the Droply Worker:
 *
 *   1. `createPairingSession` asks the Worker for a code. The Worker stores
 *      this device's public keys for five minutes under that code.
 *   2. The other device calls `joinPairingSession` with the code. The Worker
 *      hands it this device's public keys and refuses a second join.
 *   3. Each side derives the same ECDH short authentication string and the
 *      humans compare it. If they differ, the pairing is refused.
 *
 * The code is only a rendezvous: it is not a credential, never unlocks a saved
 * device, and disappears after five minutes. A saved device is authorised by
 * its ECDSA public key and the signed invites below.
 */

import { signalingUrl } from "../config.js";
import { base64UrlDecode } from "../utils/encoding.js";
import { deviceIdFromPublicJwk, verifySignature } from "./device-identity.js";
import { cleanDeviceLabel, cleanDeviceName, sanitizeAvatarId } from "./device-profile.js";

export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 6;
/** No O/0 and no I/1: the characters people mistype are simply not issued. */
export const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
export const PAIRING_TTL_MS = 5 * 60_000;
export const INVITE_MAX_AGE_MS = 10 * 60_000;

const REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const MESSAGES = {
  pair_not_found: "That pairing code wasn't found. Check the six characters and try again.",
  pair_expired: "That pairing code expired. Create a new one on the other device.",
  pair_used: "That pairing code has already been used. Create a new one.",
  pair_self: "That's this device's own code. Enter the code shown on the other device.",
  pair_joined: "This pairing already started. Create a new code to pair another device.",
  unauthorized: "This pairing session is no longer yours. Create a new code.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  network_error: "Can't reach Droply. Check your connection and try again.",
  invalid_response: "Droply sent an unexpected pairing response. Try again.",
};

export class PairingError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "PairingError";
    this.code = options.code ?? "pairing_error";
    this.status = options.status ?? 0;
  }
}

/* --------------------------------------------------------------------------
   Codes
   -------------------------------------------------------------------------- */

/**
 * Uppercase and strip spaces, hyphens and anything else that isn't A-Z/0-9.
 * Length is deliberately *not* truncated: `isValidPairingCode` must reject a
 * pasted URL or a seven-character string instead of quietly using its first
 * six characters. The input itself is capped at six by the UI.
 */
export function normalizePairingCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function isValidPairingCode(value) {
  return PAIRING_CODE_PATTERN.test(normalizePairingCode(value));
}

/**
 * Pulls a code out of whatever the user pasted or scanned: a bare code, a
 * pairing link (`…#pair=A7K9P2`) or a message containing one.
 */
export function codeFromPairingText(value) {
  const raw = String(value ?? "").trim();
  const direct = normalizePairingCode(raw);
  if (PAIRING_CODE_PATTERN.test(direct)) return direct;

  const link = raw.match(/[#?&]pair(?:ing)?=([A-Za-z0-9-]{1,12})/i);
  if (link) {
    const fromLink = normalizePairingCode(link[1]);
    if (PAIRING_CODE_PATTERN.test(fromLink)) return fromLink;
  }

  // A short message may contain the code with a hyphen or a space inside it.
  // Long pasted text is not mined for accidental six-letter words.
  if (raw.length > 40) return "";
  for (const token of raw.split(/[^A-Za-z0-9-]+/)) {
    const cleaned = normalizePairingCode(token);
    if (PAIRING_CODE_PATTERN.test(cleaned)) return cleaned;
  }
  return "";
}

/* --------------------------------------------------------------------------
   Worker API
   -------------------------------------------------------------------------- */

async function request(pathname, body) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(signalingUrl(pathname), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  } catch (error) {
    const aborted = error?.name === "AbortError";
    throw new PairingError(
      aborted ? "Droply took too long to answer. Try again." : MESSAGES.network_error,
      { code: aborted ? "pairing/timeout" : "pairing/offline" },
    );
  } finally {
    window.clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code = String(payload?.error ?? (response.status >= 500 ? "server_error" : "bad_request"));
    throw new PairingError(
      MESSAGES[code] ?? "Pairing couldn't start. Try again.",
      { code: `pairing/${code}`, status: response.status },
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new PairingError(MESSAGES.invalid_response, { code: "pairing/invalid-response" });
  }
  return payload;
}

function identityPayload(identity) {
  if (!identity?.deviceId || !identity?.publicJwk || !identity?.agreementPublicJwk) {
    throw new PairingError("This browser has no device identity yet.", {
      code: "pairing/no-identity",
    });
  }
  return {
    deviceId: identity.deviceId,
    name: cleanDeviceName(identity.name, "Droply device"),
    deviceType: cleanDeviceLabel(identity.deviceType, "Desktop"),
    platform: cleanDeviceLabel(identity.platform, "Unknown"),
    browser: cleanDeviceLabel(identity.browser, "Browser"),
    avatar: sanitizeAvatarId(identity.avatar),
    model: identity.model ? cleanDeviceLabel(identity.model) : null,
    publicKey: identity.publicJwk,
    agreementKey: identity.agreementPublicJwk,
  };
}

function readSession(data) {
  const code = normalizePairingCode(data?.code);
  const token = typeof data?.token === "string" ? data.token : "";
  if (!PAIRING_CODE_PATTERN.test(code) || !token) {
    throw new PairingError(MESSAGES.invalid_response, { code: "pairing/invalid-response" });
  }
  return {
    code,
    token,
    expiresAt: Number(data.expiresAt) || Date.now() + PAIRING_TTL_MS,
  };
}

/** Asks the Worker for a fresh code. Expires in five minutes. */
export async function createPairingSession(identity) {
  const data = await request("/api/pair", identityPayload(identity));
  return readSession(data);
}

/**
 * @param {{ code: string, token: string }} session
 * @returns {Promise<{ state: "waiting"|"joined", expiresAt: number, peer: object|null }>}
 */
export async function fetchPairingStatus({ code, token }) {
  const normalized = normalizePairingCode(code);
  if (!PAIRING_CODE_PATTERN.test(normalized)) {
    throw new PairingError("That pairing code isn't valid.", { code: "pairing/invalid" });
  }
  const data = await request(`/api/pair/${normalized}/status`, { token });
  return {
    state: data.state === "joined" ? "joined" : "waiting",
    expiresAt: Number(data.expiresAt) || Date.now() + PAIRING_TTL_MS,
    peer: data.peer ? await readPeer(data.peer) : null,
  };
}

/** Redeems the other device's code. Succeeds at most once. */
export async function joinPairingSession(identity, code) {
  const normalized = normalizePairingCode(code);
  if (!PAIRING_CODE_PATTERN.test(normalized)) {
    throw new PairingError("Enter all six characters of the pairing code.", {
      code: "pairing/invalid",
    });
  }
  const data = await request(`/api/pair/${normalized}/join`, {
    peer: identityPayload(identity),
  });
  return {
    owner: await readPeer(data.owner),
    expiresAt: Number(data.expiresAt) || Date.now() + PAIRING_TTL_MS,
  };
}

/** Rotates the code and the owner token; the previous code stops working. */
export async function regeneratePairingSession({ code, token }) {
  const normalized = normalizePairingCode(code);
  if (!PAIRING_CODE_PATTERN.test(normalized)) {
    throw new PairingError("That pairing code isn't valid.", { code: "pairing/invalid" });
  }
  return readSession(await request(`/api/pair/${normalized}/regenerate`, { token }));
}

/** Best-effort teardown when the screen closes or the user cancels. */
export async function closePairingSession({ code, token }) {
  const normalized = normalizePairingCode(code);
  if (!PAIRING_CODE_PATTERN.test(normalized) || !token) return false;
  try {
    await request(`/api/pair/${normalized}/consume`, { token });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
   Public keys, SAS and contacts
   -------------------------------------------------------------------------- */

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEcJwk(value) {
  return (
    isPlainObject(value) &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    typeof value.y === "string" &&
    value.x.length <= 200 &&
    value.y.length <= 200
  );
}

/**
 * Validates a peer descriptor and proves the id belongs to the signing key, so
 * a tampered response cannot impersonate a device.
 */
export async function readPeer(value) {
  if (!isPlainObject(value)) {
    throw new PairingError("That device didn't send usable pairing details.", {
      code: "pairing/invalid-peer",
    });
  }
  const deviceId = String(value.deviceId ?? "");
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new PairingError("That device identity isn't valid.", { code: "pairing/invalid-peer" });
  }
  if (!isEcJwk(value.publicKey) || !isEcJwk(value.agreementKey)) {
    throw new PairingError("That device didn't send a usable public key.", {
      code: "pairing/invalid-peer",
    });
  }
  const derived = await deviceIdFromPublicJwk(value.publicKey);
  if (derived !== deviceId) {
    throw new PairingError("That pairing response didn't match its device identity.", {
      code: "pairing/invalid-peer",
    });
  }

  return {
    deviceId,
    name: cleanDeviceName(value.name, "Droply device"),
    deviceType: cleanDeviceLabel(value.deviceType, "Desktop"),
    platform: cleanDeviceLabel(value.platform, "Unknown"),
    browser: cleanDeviceLabel(value.browser, "Browser"),
    avatar: sanitizeAvatarId(value.avatar),
    model: value.model ? cleanDeviceLabel(value.model) : null,
    publicKey: value.publicKey,
    agreementKey: value.agreementKey,
  };
}

/** Six-digit short authentication string derived from the ECDH secret. */
export async function deriveSas(agreementKey, remoteAgreementJwk) {
  const remote = await crypto.subtle.importKey(
    "jwk",
    remoteAgreementJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, agreementKey, 256);
  const digest = await crypto.subtle.digest("SHA-256", bits);
  const view = new DataView(digest);
  const value = view.getUint32(0) % 1_000_000;
  return String(value).padStart(6, "0").replace(/(\d{3})(\d{3})/, "$1 $2");
}

/**
 * Turns a validated peer into the contact to store, plus the SAS the user must
 * compare. Nothing is persisted here; the caller decides.
 */
export async function acceptPairingPeer(identity, peer, { now = Date.now() } = {}) {
  const clean = await readPeer(peer);
  if (clean.deviceId === identity.deviceId) {
    throw new PairingError("That's this device's own code. Enter the code shown on the other device.", {
      code: "pairing/self",
    });
  }
  const sas = await deriveSas(identity.agreementKey, clean.agreementKey);
  return {
    sas,
    contact: {
      deviceId: clean.deviceId,
      name: clean.name,
      deviceType: clean.deviceType,
      platform: clean.platform,
      browser: clean.browser,
      avatar: clean.avatar,
      publicKey: clean.publicKey,
      pairedAt: now,
      lastConnectedAt: now,
    },
  };
}

/* --------------------------------------------------------------------------
   Invites
   -------------------------------------------------------------------------- */

function canonicalInvite(invite) {
  const version = Number(invite?.v) === 2 ? 2 : 1;
  const base = [
    "droply-invite",
    version,
    String(invite?.to ?? ""),
    String(invite?.code ?? ""),
    String(invite?.fromDeviceId ?? ""),
    String(invite?.fromName ?? ""),
  ];
  if (version === 2) {
    base.push(
      sanitizeAvatarId(invite?.fromAvatar),
      cleanDeviceLabel(invite?.fromDeviceType, "Desktop"),
      cleanDeviceLabel(invite?.fromPlatform, "Unknown"),
      cleanDeviceLabel(invite?.fromBrowser, "Browser"),
    );
  }
  base.push(Number(invite?.issuedAt ?? 0));
  return JSON.stringify(base);
}

/**
 * Signs an invite for one peer. The room code is a normal one-time Droply
 * room; the signature is what lets the other device prove who asked.
 */
export async function createInvite(identity, { to, code, issuedAt = Date.now() }) {
  const base = {
    v: 2,
    to: String(to ?? ""),
    code: String(code ?? "").toUpperCase(),
    fromDeviceId: identity.deviceId,
    fromName: cleanDeviceName(identity.name, "Droply device"),
    fromAvatar: sanitizeAvatarId(identity.avatar),
    fromDeviceType: cleanDeviceLabel(identity.deviceType, "Desktop"),
    fromPlatform: cleanDeviceLabel(identity.platform, "Unknown"),
    fromBrowser: cleanDeviceLabel(identity.browser, "Browser"),
    issuedAt,
  };
  const sig = await identity.sign(canonicalInvite(base));
  return { ...base, sig };
}

/**
 * @param {object} publicKeyJwk The saved device's signing key.
 * @param {object} invite
 * @param {{ now?: number }} [options]
 */
export async function verifyInvite(publicKeyJwk, invite, { now = Date.now() } = {}) {
  if (!isPlainObject(invite) || !isEcJwk(publicKeyJwk)) return false;
  if (typeof invite.sig !== "string" || !invite.sig) return false;
  if (Math.abs(now - Number(invite.issuedAt ?? 0)) > INVITE_MAX_AGE_MS) return false;
  const { sig, ...rest } = invite;
  if (rest.v !== 1 && rest.v !== 2) return false;
  return verifySignature(publicKeyJwk, canonicalInvite(rest), sig);
}

/** True when a room code from an invite is actually usable. */
export function isInviteShape(value) {
  return (
    isPlainObject(value) &&
    (Number(value.v) === 1 || Number(value.v) === 2) &&
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(String(value.code ?? "").toUpperCase()) &&
    typeof value.fromDeviceId === "string" &&
    typeof value.fromName === "string" &&
    typeof value.sig === "string" &&
    Number.isFinite(Number(value.issuedAt))
  );
}

/** Decodes a base64url signature for debugging/tests without throwing. */
export function signatureBytes(signature) {
  try {
    return base64UrlDecode(signature);
  } catch {
    return new Uint8Array(0);
  }
}
