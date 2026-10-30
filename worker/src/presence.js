/**
 * Nearby presence Durable Object.
 *
 * Browsers cannot scan a LAN for other browsers, so Droply uses an explicit
 * opt-in presence registry instead: a client registers a short-lived record
 * and the Worker groups it with other devices that share the same hashed
 * public network address (the closest thing to "same Wi-Fi" a server can see).
 *
 * Privacy rules enforced here:
 *  - nothing is stored beyond an in-memory/short-lived record (2 minute TTL)
 *  - a record disappears the moment its socket closes or its lease expires
 *  - the network grouping key never leaves the Worker
 *  - only a random peer id, a pseudonymous device id, a display name, a coarse
 *    device type and an availability flag are ever broadcast
 *  - invite payloads are relayed verbatim and never stored
 *
 * File bytes never reach this object: the only messages accepted are small
 * JSON control frames.
 */

import { jsonResponse, randomHex, randomToken, hashToken, hashesEqual } from "./util.js";

/** A record is dropped this long after its last heartbeat. */
export const PEER_TTL_MS = 120_000;
export const MAX_PEERS = 25;
export const MAX_MESSAGE_BYTES = 8 * 1024;
export const MAX_INVITE_BYTES = 2 * 1024;
const MESSAGE_WINDOW_MS = 10_000;
const MESSAGE_BURST = 60;

const PEERS_KEY = "peers";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const PEER_ID_PATTERN = /^[a-f0-9]{32}$/;
const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Must match js/core/device-profile.js; unknown values collapse to generic. */
export const AVATAR_IDS = Object.freeze([
  "windows",
  "mac",
  "macbook",
  "linux",
  "desktop",
  "laptop",
  "android",
  "iphone",
  "mobile",
  "tablet",
  "generic",
]);

/** Never trust a display name: strip control characters and clamp length. */
export function sanitizeDisplayName(value) {
  return String(value ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** Coarse platform label ("Desktop · Chrome"), not a fingerprint. */
export function sanitizeDeviceType(value) {
  return String(value ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(/[^\w ·./-]/g, "")
    .trim()
    .slice(0, 40);
}

/** Avatar ids are a closed set; anything else becomes the generic device. */
export function sanitizeAvatar(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return AVATAR_IDS.includes(id) ? id : "generic";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The invite envelope is relayed, but its shape is still validated. */
export function parseInvitePayload(value) {
  if (!isPlainObject(value)) return null;
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }
  if (encoded.length > MAX_INVITE_BYTES) return null;

  const code = String(value.code ?? "").toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) return null;
  if (!DEVICE_ID_PATTERN.test(String(value.fromDeviceId ?? ""))) return null;
  if (typeof value.fromName !== "string" || value.fromName.length > 60) return null;
  if (!Number.isFinite(Number(value.issuedAt))) return null;
  if (typeof value.sig !== "string" || !value.sig || value.sig.length > 200) return null;
  const version = Number(value.v) === 2 ? 2 : 1;

  return {
    v: version,
    code,
    fromDeviceId: String(value.fromDeviceId),
    fromName: sanitizeDisplayName(value.fromName) || "Nearby device",
    ...(version === 2
      ? {
          fromAvatar: sanitizeAvatar(value.fromAvatar),
          fromDeviceType: sanitizeDeviceType(value.fromDeviceType) || "Desktop",
          fromPlatform: sanitizeDeviceType(value.fromPlatform) || "Unknown",
          fromBrowser: sanitizeDeviceType(value.fromBrowser) || "Browser",
        }
      : {}),
    issuedAt: Number(value.issuedAt),
    sig: value.sig,
  };
}

/** Public projection of a stored record: no token hash, no timestamps of note. */
export function publicPeer(record) {
  return {
    peerId: record.peerId,
    deviceId: record.deviceId,
    name: record.name,
    deviceType: record.deviceType,
    platform: record.platform ?? "Unknown",
    browser: record.browser ?? "Browser",
    avatar: record.avatar ?? "generic",
    available: record.available !== false,
    joinedAt: record.joinedAt,
  };
}

export class Presence {
  /**
   * @param {DurableObjectState} state
   * @param {Record<string, unknown>} [env]
   */
  constructor(state, env) {
    this.state = state;
    this.env = env ?? {};
    /** @type {Record<string, object>|undefined} */
    this.peers = undefined;
    /** @type {WeakMap<object, {count: number, resetAt: number}>} */
    this.windows = new WeakMap();
  }

  /* ------------------------------ storage ------------------------------ */

  async #load() {
    if (this.peers !== undefined) return this.peers;
    this.peers = (await this.state.storage.get(PEERS_KEY)) ?? {};
    return this.peers;
  }

  async #save() {
    await this.state.storage.put(PEERS_KEY, this.peers);
    await this.#reschedule();
  }

  /** Drops every record whose lease ran out, closing its sockets. */
  #prune() {
    if (!this.peers) return false;
    const now = Date.now();
    let changed = false;
    for (const [peerId, record] of Object.entries(this.peers)) {
      if (record.lastSeen + PEER_TTL_MS <= now) {
        this.#closePeer(peerId, 4008, "expired");
        delete this.peers[peerId];
        changed = true;
      }
    }
    return changed;
  }

  async #reschedule() {
    let next = 0;
    for (const record of Object.values(this.peers ?? {})) {
      const at = record.lastSeen + PEER_TTL_MS;
      if (!next || at < next) next = at;
    }
    if (next) await this.state.storage.setAlarm(next);
    else await this.state.storage.deleteAlarm();
  }

  /* ------------------------------- routes ------------------------------- */

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/register") return this.#register(request);
    if (url.pathname === "/socket") return this.#socket(request);
    if (url.pathname === "/count") {
      await this.#load();
      this.#prune();
      return jsonResponse({ peers: Object.keys(this.peers).length });
    }
    return jsonResponse({ error: "not_found" }, 404);
  }

  /**
   * POST /register { deviceId, name, deviceType }
   * Called by the Worker once per discovery session. Re-registering the same
   * device replaces its old record so a device is never listed twice.
   */
  async #register(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    if (!isPlainObject(body)) return jsonResponse({ error: "bad_request" }, 400);

    const deviceId = String(body.deviceId ?? "");
    if (!DEVICE_ID_PATTERN.test(deviceId)) return jsonResponse({ error: "bad_request" }, 400);

    await this.#load();
    this.#prune();

    // One record per device: drop any previous session for it.
    for (const [peerId, record] of Object.entries(this.peers)) {
      if (record.deviceId === deviceId) {
        this.#closePeer(peerId, 4001, "replaced");
        delete this.peers[peerId];
      }
    }

    if (Object.keys(this.peers).length >= MAX_PEERS) {
      return jsonResponse({ error: "presence_full" }, 429);
    }

    const token = randomToken();
    const peerId = randomHex(16);
    const now = Date.now();
    this.peers[peerId] = {
      peerId,
      deviceId,
      name: sanitizeDisplayName(body.name) || "Droply device",
      deviceType: sanitizeDeviceType(body.deviceType),
      platform: sanitizeDeviceType(body.platform),
      browser: sanitizeDeviceType(body.browser),
      avatar: sanitizeAvatar(body.avatar),
      available: body.available !== false,
      joinedAt: now,
      lastSeen: now,
      tokenHash: await hashToken(token),
      connected: false,
    };
    await this.#save();

    return jsonResponse({
      peerId,
      token,
      expiresAt: now + PEER_TTL_MS,
      ttlSeconds: Math.round(PEER_TTL_MS / 1000),
    });
  }

  /** GET /socket?token=... — one hibernatable socket per presence record. */
  async #socket(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "upgrade_required" }, 426);
    }
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!token || token.length > 128) return jsonResponse({ error: "unauthorized" }, 401);

    await this.#load();
    this.#prune();

    const tokenHash = await hashToken(token);
    let record = null;
    for (const candidate of Object.values(this.peers)) {
      if (hashesEqual(tokenHash, candidate.tokenHash)) {
        record = candidate;
        break;
      }
    }
    if (!record) return jsonResponse({ error: "unauthorized" }, 401);

    // A reconnect replaces the previous socket for this presence record.
    this.#closePeer(record.peerId, 4001, "replaced");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [record.peerId]);
    server.serializeAttachment({ peerId: record.peerId });

    record.connected = true;
    record.lastSeen = Date.now();
    await this.#save();

    this.#send(server, {
      type: "ready",
      peerId: record.peerId,
      peers: this.#snapshot(),
      ttlSeconds: Math.round(PEER_TTL_MS / 1000),
    });
    this.#broadcastSnapshot(record.peerId);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* --------------------------- socket handlers --------------------------- */

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      this.#closeSocket(ws, 1003, "unsupported-frame");
      return;
    }
    if (message.length > MAX_MESSAGE_BYTES) {
      this.#closeSocket(ws, 1009, "message-too-large");
      return;
    }

    await this.#load();
    if (this.#prune()) await this.#save();

    const attachment = ws.deserializeAttachment() ?? {};
    const record = this.peers[attachment.peerId];
    if (!record) {
      this.#closeSocket(ws, 4004, "unknown-peer");
      return;
    }
    if (!this.#allowMessage(ws)) {
      this.#closeSocket(ws, 4029, "rate-limited");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      this.#send(ws, { type: "error", code: "invalid_message", message: "Malformed JSON." });
      return;
    }
    if (!isPlainObject(payload) || typeof payload.type !== "string") {
      this.#send(ws, { type: "error", code: "invalid_message", message: "Unknown message." });
      return;
    }

    record.lastSeen = Date.now();

    switch (payload.type) {
      case "ping":
        this.#send(ws, { type: "pong" });
        await this.#save();
        return;

      case "refresh":
        this.#send(ws, { type: "presence", peers: this.#snapshot() });
        await this.#save();
        return;

      case "availability": {
        record.available = payload.available !== false;
        await this.#save();
        this.#broadcastSnapshot();
        return;
      }

      case "invite": {
        const target = this.peers[String(payload.to ?? "")];
        const invite = parseInvitePayload(payload.invite);
        if (!PEER_ID_PATTERN.test(String(payload.to ?? "")) || !invite) {
          this.#send(ws, { type: "error", code: "invalid_invite", message: "Invalid invite." });
          return;
        }
        const delivered = target
          ? this.#deliver(target.peerId, { type: "invite", from: publicPeer(record), invite })
          : false;
        await this.#save();
        this.#send(ws, { type: "invite-sent", to: target?.peerId ?? null, delivered });
        return;
      }

      case "invite-response": {
        const target = this.peers[String(payload.to ?? "")];
        if (!target) {
          this.#send(ws, { type: "error", code: "unknown_peer", message: "That device left." });
          return;
        }
        this.#deliver(target.peerId, {
          type: "invite-response",
          from: publicPeer(record),
          accepted: payload.accepted === true,
        });
        await this.#save();
        return;
      }

      case "leave": {
        delete this.peers[record.peerId];
        await this.#save();
        this.#closeSocket(ws, 1000, "left");
        this.#broadcastSnapshot();
        return;
      }

      default:
        this.#send(ws, { type: "error", code: "unknown_type", message: "Unknown message type." });
        return;
    }
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() ?? {};
    if (!attachment.peerId) return;
    await this.#load();
    if (!this.peers[attachment.peerId]) return;
    delete this.peers[attachment.peerId];
    await this.#save();
    this.#broadcastSnapshot();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    await this.#load();
    const changed = this.#prune();
    if (changed) await this.#save();
    else await this.#reschedule();
    this.#broadcastSnapshot();
  }

  /* ------------------------------ internals ------------------------------ */

  /** A per-socket flood guard; hibernation only resets it, which is safe. */
  #allowMessage(ws) {
    const now = Date.now();
    let window = this.windows.get(ws);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + MESSAGE_WINDOW_MS };
      this.windows.set(ws, window);
    }
    window.count += 1;
    return window.count <= MESSAGE_BURST;
  }

  #snapshot() {
    return Object.values(this.peers ?? {})
      .filter((record) => record.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(publicPeer);
  }

  #broadcastSnapshot(exceptPeerId = null) {
    const peers = this.#snapshot();
    const message = { type: "presence", peers };
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() ?? {};
      if (exceptPeerId && attachment.peerId === exceptPeerId) {
        this.#send(socket, { ...message, self: exceptPeerId });
        continue;
      }
      this.#send(socket, message);
    }
  }

  /** Sends to the live socket(s) of one peer. Returns whether one existed. */
  #deliver(peerId, message) {
    const sockets = this.state.getWebSockets(peerId);
    if (!sockets.length) return false;
    for (const socket of sockets) this.#send(socket, message);
    return true;
  }

  #send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* socket already closing */
    }
  }

  #closeSocket(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  #closePeer(peerId, code, reason) {
    for (const socket of this.state.getWebSockets(peerId)) this.#closeSocket(socket, code, reason);
  }
}
