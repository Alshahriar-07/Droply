/**
 * Device pairing sessions.
 *
 * A pairing session is a short-lived rendezvous for two public keys. It exists
 * only so a user can type six characters instead of showing a long payload:
 *
 *   1. Device A asks the Worker for a code. A `Pairing` object keyed by that
 *      code stores A's public keys and a hash of A's owner token for 5 minutes.
 *   2. Device B redeems the code once. The object now also holds B's public
 *      keys and refuses any further join; both sides can read the other's keys.
 *   3. Each side derives the same ECDH short authentication string and the
 *      humans compare it. Only then does either browser store a contact.
 *
 * Nothing here is an authentication credential: the code is a one-time
 * rendezvous, the owner token only reads/rotates/ends its own session, and both
 * are gone within five minutes. Reconnection later is authorised by the saved
 * device's ECDSA key and signed invites (see js/core/pairing.js), never by this
 * code. No file data and no private key ever reaches this object.
 */

import { hashesEqual, hashToken, jsonResponse, randomToken } from "./util.js";
import { sanitizeAvatar, sanitizeDeviceType, sanitizeDisplayName } from "./presence.js";

/** Short by design: long enough to type, short enough to expire quickly. */
export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_TTL_SECONDS = 300;

/**
 * 32 unambiguous characters (no O/0, no I/1). 32^6 ≈ 1.07 billion codes, and a
 * code is only valid for five minutes, one join and a handful of attempts.
 */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

const SESSION_KEY = "session";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_KEY_FIELD = 200;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Cryptographically secure code, uniform over the 32-character alphabet. */
export function randomPairingCode() {
  let code = "";
  const bytes = new Uint8Array(24);
  while (code.length < 6) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
      if (code.length === 6) break;
    }
  }
  return code;
}

/** A P-256 public JWK, with bounded fields. */
export function isEcJwk(value) {
  return (
    isPlainObject(value) &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    typeof value.y === "string" &&
    value.x.length > 0 &&
    value.y.length > 0 &&
    value.x.length <= MAX_KEY_FIELD &&
    value.y.length <= MAX_KEY_FIELD
  );
}

function cleanJwk(jwk) {
  return { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y) };
}

/**
 * Validates the public half of a device. Anything a client sends is treated as
 * hostile: only the five fields below survive.
 *
 * @returns {{deviceId: string, name: string, deviceType: string, platform: string, browser: string, avatar: string, publicKey: object, agreementKey: object} | null}
 */
export function sanitizePeer(value) {
  if (!isPlainObject(value)) return null;
  const deviceId = String(value.deviceId ?? "");
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
  if (!isEcJwk(value.publicKey) || !isEcJwk(value.agreementKey)) return null;
  return {
    deviceId,
    name: sanitizeDisplayName(value.name) || "Droply device",
    deviceType: sanitizeDeviceType(value.deviceType) || "Desktop",
    platform: sanitizeDeviceType(value.platform) || "Unknown",
    browser: sanitizeDeviceType(value.browser) || "Browser",
    avatar: sanitizeAvatar(value.avatar),
    publicKey: cleanJwk(value.publicKey),
    agreementKey: cleanJwk(value.agreementKey),
  };
}

export class Pairing {
  /**
   * @param {DurableObjectState} state
   * @param {Record<string, unknown>} [env]
   */
  constructor(state, env) {
    this.state = state;
    this.env = env ?? {};
    /** @type {object|null|undefined} */
    this.session = undefined;
  }

  /* ------------------------------ storage ------------------------------ */

  async #load() {
    if (this.session !== undefined) return this.session;
    this.session = (await this.state.storage.get(SESSION_KEY)) ?? null;
    return this.session;
  }

  async #save() {
    if (this.session) await this.state.storage.put(SESSION_KEY, this.session);
    else await this.state.storage.delete(SESSION_KEY);
    await this.#reschedule();
  }

  async #reschedule() {
    if (this.session?.expiresAt) await this.state.storage.setAlarm(this.session.expiresAt);
    else await this.state.storage.deleteAlarm();
  }

  /**
   * Returns the live session, or flags that it existed but has expired so the
   * UI can say "expired" rather than "not found".
   */
  async #live() {
    const session = await this.#load();
    if (!session) return { session: null, expired: false };
    if (session.expiresAt <= Date.now()) {
      this.session = null;
      await this.state.storage.delete(SESSION_KEY);
      await this.state.storage.deleteAlarm();
      return { session: null, expired: true };
    }
    return { session, expired: false };
  }

  async #authorized(session, token) {
    if (!session || typeof token !== "string" || !token) return false;
    return hashesEqual(await hashToken(token), session.ownerTokenHash);
  }

  /* ------------------------------- routes ------------------------------- */

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/init":
        return this.#init(request);
      case "/status":
        return this.#status(request);
      case "/join":
        return this.#join(request);
      case "/verify":
        return this.#verify(request);
      case "/consume":
        return this.#consume(request);
      default:
        return jsonResponse({ error: "not_found" }, 404);
    }
  }

  /**
   * POST /init { code, owner, tokenHash, ttlSeconds }
   * Called by the Worker once it has allocated a unique code.
   */
  async #init(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    if (!isPlainObject(body)) return jsonResponse({ error: "bad_request" }, 400);

    const code = String(body.code ?? "").toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(code)) return jsonResponse({ error: "bad_request" }, 400);
    if (typeof body.tokenHash !== "string" || !TOKEN_HASH_PATTERN.test(body.tokenHash)) {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    const owner = sanitizePeer(body.owner);
    if (!owner) return jsonResponse({ error: "bad_request" }, 400);

    // A live session must never be overwritten: that would silently swap the
    // keys a user is looking at. The Worker retries with a different code.
    const existing = await this.#load();
    if (existing && existing.expiresAt > Date.now()) {
      return jsonResponse({ error: "pair_exists" }, 409);
    }

    const now = Date.now();
    const ttlSeconds = Math.min(600, Math.max(60, Number(body.ttlSeconds) || PAIRING_TTL_SECONDS));
    this.session = {
      code,
      owner,
      ownerTokenHash: body.tokenHash,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      joiner: null,
      joinedAt: 0,
    };
    await this.#save();

    return jsonResponse({
      code,
      expiresAt: this.session.expiresAt,
      ttlSeconds,
    });
  }

  /** POST /status { token } — owner-only view of a pending session. */
  async #status(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const body = await this.#body(request);
    if (!body) return jsonResponse({ error: "bad_request" }, 400);

    const session = await this.#live();
    if (!session.session) {
      return jsonResponse({ error: session.expired ? "pair_expired" : "pair_not_found" }, session.expired ? 410 : 404);
    }
    if (!(await this.#authorized(session.session, body.token))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    return jsonResponse({
      state: session.session.joiner ? "joined" : "waiting",
      expiresAt: session.session.expiresAt,
      peer: session.session.joiner,
    });
  }

  /**
   * POST /join { peer } — redeems the code exactly once.
   * Returns the owner's public half; nothing secret is ever sent back.
   */
  async #join(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const body = await this.#body(request);
    if (!body) return jsonResponse({ error: "bad_request" }, 400);

    const { session, expired } = await this.#live();
    if (!session) {
      return jsonResponse({ error: expired ? "pair_expired" : "pair_not_found" }, expired ? 410 : 404);
    }

    const peer = sanitizePeer(body.peer);
    if (!peer) return jsonResponse({ error: "bad_request" }, 400);
    if (peer.deviceId === session.owner.deviceId) {
      return jsonResponse({ error: "pair_self" }, 409);
    }
    if (session.joiner) return jsonResponse({ error: "pair_used" }, 409);

    session.joiner = peer;
    session.joinedAt = Date.now();
    await this.#save();

    return jsonResponse({
      owner: session.owner,
      expiresAt: session.expiresAt,
      state: "joined",
    });
  }

  /** POST /verify { token } — used by the Worker before a rotation. */
  async #verify(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const body = await this.#body(request);
    if (!body) return jsonResponse({ error: "bad_request" }, 400);

    const { session } = await this.#live();
    if (!session) return jsonResponse({ error: "pair_not_found" }, 404);
    if (!(await this.#authorized(session, body.token))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    return jsonResponse({
      owner: session.owner,
      joined: Boolean(session.joiner),
      expiresAt: session.expiresAt,
    });
  }

  /** POST /consume { token } — ends a session (on save, cancel or rotate). */
  async #consume(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const body = await this.#body(request);
    if (!body) return jsonResponse({ error: "bad_request" }, 400);

    const { session } = await this.#live();
    if (!session) return jsonResponse({ ok: true });
    if (!(await this.#authorized(session, body.token))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    this.session = null;
    await this.#save();
    return jsonResponse({ ok: true });
  }

  async alarm() {
    const session = await this.#load();
    if (session && session.expiresAt <= Date.now()) {
      this.session = null;
      await this.state.storage.delete(SESSION_KEY);
      await this.state.storage.deleteAlarm();
    } else if (session) {
      await this.#reschedule();
    }
  }

  async #body(request) {
    try {
      const body = await request.json();
      return isPlainObject(body) ? body : null;
    } catch {
      return null;
    }
  }
}

/** Exposed so the Worker can issue an owner token without importing internals. */
export function newOwnerToken() {
  return randomToken();
}
