/**
 * Durable Object room + rate limiter for Droply signaling.
 *
 * A Room instance owns exactly one six-character code. It stores only
 * connection metadata (hashed role tokens, timestamps, status) and relays
 * WebRTC negotiation messages between at most one sender and one receiver.
 * File bytes never reach this service.
 */

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 32 * 1024;
const MAX_CANDIDATE_BYTES = 2048;
const DEFAULT_TTL_SECONDS = 600;
const PAIRED_TTL_MS = 30 * 60_000;
const RECEIVER_GRACE_MS = 60_000;

const ROOM_STORAGE_KEY = "room";

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Length-independent comparison to avoid timing leaks on token hashes. */
function hashesEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isSdp(value) {
  return typeof value === "string" && value.length >= 16 && value.length <= MAX_SDP_BYTES && value.startsWith("v=0");
}

function isCandidate(value) {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  return typeof value.candidate === "string" && value.candidate.length <= MAX_CANDIDATE_BYTES;
}

/* --------------------------------------------------------------------------
   Room
   -------------------------------------------------------------------------- */

export class Room {
  /**
   * @param {DurableObjectState} state
   * @param {{ ROOM_TTL_SECONDS?: string }} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {object|null|undefined} undefined = not loaded yet */
    this.cached = undefined;
  }

  /* ------------------------------ storage ------------------------------ */

  async #load() {
    if (this.cached !== undefined) return this.cached;
    this.cached = (await this.state.storage.get(ROOM_STORAGE_KEY)) ?? null;
    return this.cached;
  }

  async #save(room) {
    this.cached = room;
    await this.state.storage.put(ROOM_STORAGE_KEY, room);
    if (room) await this.state.storage.setAlarm(room.expiresAt);
  }

  async #destroy() {
    this.cached = null;
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
  }

  get #ttlMs() {
    const fromEnv = Number.parseInt(this.env?.ROOM_TTL_SECONDS ?? "", 10);
    const seconds = Number.isFinite(fromEnv) ? Math.min(3600, Math.max(120, fromEnv)) : DEFAULT_TTL_SECONDS;
    return seconds * 1000;
  }

  /* ------------------------------- routes ------------------------------- */

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/init":
        return this.#init(request);
      case "/join":
        return this.#join(request);
      case "/socket":
        return this.#socket(request);
      case "/status":
        return this.#status();
      default:
        return jsonResponse({ error: "not_found" }, 404);
    }
  }

  /** POST /init { code } — called by the Worker after it claims a code. */
  async #init(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    const code = String(body?.code ?? "").toUpperCase();
    if (!CODE_PATTERN.test(code)) return jsonResponse({ error: "invalid_code" }, 400);

    const now = Date.now();
    const existing = await this.#load();
    if (existing) {
      if (existing.expiresAt > now && existing.status !== "closed") {
        return jsonResponse({ error: "conflict" }, 409);
      }
      // Stale room: close any lingering sockets and start fresh.
      await this.#closeAllSockets("expired");
      await this.#destroy();
    }

    const token = randomToken();
    const room = {
      code,
      status: "waiting",
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      pairedAt: null,
      acceptedAt: null,
      senderHash: await hashToken(token),
      receiverHash: null,
      senderConnected: false,
      receiverConnected: false,
    };
    await this.#save(room);

    return jsonResponse({
      code,
      token,
      expiresAt: room.expiresAt,
      ttlSeconds: Math.round((room.expiresAt - now) / 1000),
    });
  }

  /** POST /join — issues the single receiver slot for a live room. */
  async #join(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

    const room = await this.#load();
    const now = Date.now();

    if (!room || room.status === "closed") return jsonResponse({ error: "room_not_found" }, 404);
    if (room.expiresAt <= now) {
      await this.#expire();
      return jsonResponse({ error: "room_expired" }, 410);
    }
    if (room.receiverHash) return jsonResponse({ error: "room_occupied" }, 409);

    const token = randomToken();
    room.receiverHash = await hashToken(token);
    room.status = "pairing";
    // The receiver slot is intentionally permanent for the room's lifetime so a
    // guessed code cannot be used to displace the legitimate receiver.
    await this.#save(room);

    return jsonResponse({
      code: room.code,
      token,
      expiresAt: room.expiresAt,
      ttlSeconds: Math.max(0, Math.round((room.expiresAt - now) / 1000)),
    });
  }

  async #status() {
    const room = await this.#load();
    if (!room) return jsonResponse({ available: false, error: "room_not_found" }, 404);
    return jsonResponse({
      available: room.expiresAt > Date.now(),
      expiresAt: room.expiresAt,
      locked: Boolean(room.receiverHash),
    });
  }

  /* ------------------------------ websocket ------------------------------ */

  async #socket(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "upgrade_required" }, 426);
    }

    const token = new URL(request.url).searchParams.get("token") ?? "";
    const room = await this.#load();
    if (!room) return jsonResponse({ error: "room_not_found" }, 404);
    if (room.expiresAt <= Date.now()) {
      await this.#expire();
      return jsonResponse({ error: "room_expired" }, 410);
    }

    const tokenHash = await hashToken(token);
    let role = null;
    if (hashesEqual(tokenHash, room.senderHash)) role = "sender";
    else if (hashesEqual(tokenHash, room.receiverHash)) role = "receiver";
    if (!role) return jsonResponse({ error: "unauthorized" }, 401);

    // Hibernatable WebSockets keep the room alive without holding a connection
    // in memory, and tags let us address each role after a restart.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // One live socket per role: a reconnect replaces the previous connection.
    for (const socket of this.state.getWebSockets(role)) {
      try {
        socket.close(4001, "replaced");
      } catch {
        /* already closed */
      }
    }

    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    const now = Date.now();
    if (role === "sender") room.senderConnected = true;
    else room.receiverConnected = true;

    if (room.senderConnected && room.receiverConnected && !room.pairedAt) {
      room.pairedAt = now;
      room.expiresAt = Math.max(room.expiresAt, now + PAIRED_TTL_MS);
      room.status = "connected";
    }
    await this.#save(room);

    this.#send(server, {
      type: "ready",
      code: room.code,
      role,
      expiresAt: room.expiresAt,
      peers: {
        sender: this.state.getWebSockets("sender").length > 0,
        receiver: this.state.getWebSockets("receiver").length > 0,
      },
    });

    if (role === "receiver") {
      this.#broadcast("sender", { type: "peer_joined", role: "receiver" });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /* --------------------------- socket handlers --------------------------- */

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      this.#closeSocket(ws, 1003, "unsupported-frame");
      return;
    }
    if (message.length > MAX_WS_MESSAGE_BYTES) {
      this.#closeSocket(ws, 1009, "message-too-large");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      this.#send(ws, { type: "error", code: "invalid_message", message: "Malformed JSON." });
      return;
    }
    if (!payload || typeof payload !== "object" || typeof payload.type !== "string") {
      this.#send(ws, { type: "error", code: "invalid_message", message: "Unknown message." });
      return;
    }

    const room = await this.#load();
    if (!room) {
      this.#closeSocket(ws, 4004, "room-closed");
      return;
    }
    if (room.expiresAt <= Date.now()) {
      await this.#expire();
      return;
    }

    const attachment = ws.deserializeAttachment() ?? {};
    const role = attachment.role;
    if (role !== "sender" && role !== "receiver") {
      this.#closeSocket(ws, 4003, "unauthorized");
      return;
    }

    switch (payload.type) {
      case "ping":
        this.#send(ws, { type: "pong" });
        break;

      case "offer":
        if (role !== "sender" || !isSdp(payload.sdp)) {
          this.#send(ws, { type: "error", code: "invalid_offer", message: "Invalid offer." });
          return;
        }
        this.#broadcast("receiver", { type: "offer", sdp: payload.sdp });
        break;

      case "answer":
        if (role !== "receiver" || !isSdp(payload.sdp)) {
          this.#send(ws, { type: "error", code: "invalid_answer", message: "Invalid answer." });
          return;
        }
        this.#broadcast("sender", { type: "answer", sdp: payload.sdp });
        break;

      case "ice": {
        if (!isCandidate(payload.candidate)) {
          this.#send(ws, { type: "error", code: "invalid_candidate", message: "Invalid candidate." });
          return;
        }
        const target = role === "sender" ? "receiver" : "sender";
        this.#broadcast(target, { type: "ice", candidate: payload.candidate });
        break;
      }

      case "receiver_accept":
        if (role !== "receiver") return;
        room.acceptedAt = Date.now();
        room.status = "transferring";
        await this.#save(room);
        this.#broadcast("sender", { type: "receiver_accept" });
        break;

      case "receiver_reject":
        if (role !== "receiver") return;
        this.#broadcast("sender", { type: "receiver_reject" });
        await this.#closeRoom("rejected");
        break;

      case "complete":
        // The sender only sends this after the receiver confirmed delivery.
        if (role !== "sender") return;
        room.status = "completed";
        await this.#save(room);
        await this.#closeRoom("completed");
        break;

      case "cancel":
        await this.#closeRoom("cancelled");
        break;

      case "leave":
        this.#closeSocket(ws, 1000, "left");
        break;

      default:
        this.#send(ws, { type: "error", code: "unknown_type", message: "Unknown message type." });
        break;
    }
  }

  async webSocketClose(ws) {
    const room = await this.#load();
    const attachment = ws.deserializeAttachment() ?? {};
    const role = attachment.role;
    if (!room || (role !== "sender" && role !== "receiver")) return;

    // A reconnect replaces the socket for its role. Ignore the close event of
    // the replaced socket so it cannot mark the peer as disconnected.
    const activeForRole = this.state
      .getWebSockets(role)
      .filter((socket) => socket !== ws);
    if (activeForRole.length > 0) return;

    if (role === "sender") room.senderConnected = false;
    else room.receiverConnected = false;

    this.#broadcastOther(role, { type: "peer_left", role, graceMs: RECEIVER_GRACE_MS });

    if (role === "sender" && room.status !== "completed") {
      await this.#closeRoom("sender-left");
      return;
    }

    if (role === "receiver" && room.status !== "completed") {
      // Give a reconnecting receiver a short window before the room closes.
      const deadline = Date.now() + RECEIVER_GRACE_MS;
      if (room.expiresAt > deadline) {
        room.expiresAt = deadline;
        await this.#save(room);
      }
      return;
    }

    await this.#save(room);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const room = await this.#load();
    if (!room) {
      await this.state.storage.deleteAlarm();
      return;
    }
    if (room.expiresAt <= Date.now()) {
      await this.#expire();
    } else {
      await this.state.storage.setAlarm(room.expiresAt);
    }
  }

  /* ------------------------------ internals ------------------------------ */

  #send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* socket already closing */
    }
  }

  #broadcast(role, message) {
    for (const socket of this.state.getWebSockets(role)) this.#send(socket, message);
  }

  #broadcastOther(role, message) {
    this.#broadcast(role === "sender" ? "receiver" : "sender", message);
  }

  #closeSocket(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  async #closeAllSockets(reason) {
    for (const ws of this.state.getWebSockets()) this.#closeSocket(ws, 1000, reason);
  }

  async #closeRoom(reason) {
    const room = await this.#load();
    if (!room) return;
    for (const ws of this.state.getWebSockets()) {
      this.#send(ws, { type: "room_closed", reason });
    }
    await this.#closeAllSockets(reason);
    await this.#destroy();
  }

  async #expire() {
    await this.#closeRoom("expired");
  }
}

/* --------------------------------------------------------------------------
   Rate limiter (one Durable Object per IP hash + bucket)
   -------------------------------------------------------------------------- */

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "bad_request" }, 400);
    }

    const limit = Math.min(1000, Math.max(1, Number(body?.limit) || 30));
    const windowMs = Math.min(3_600_000, Math.max(10_000, Number(body?.windowMs) || 600_000));
    const key = "window";
    const now = Date.now();

    let record = await this.state.storage.get(key);
    if (!record || now >= record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
    }
    record.count += 1;
    await this.state.storage.put(key, record);
    await this.state.storage.setAlarm(record.resetAt);

    const allowed = record.count <= limit;
    return jsonResponse(
      {
        allowed,
        limit,
        remaining: Math.max(0, limit - record.count),
        retryAfter: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
      },
      allowed ? 200 : 429,
      allowed ? {} : { "retry-after": String(Math.max(1, Math.ceil((record.resetAt - now) / 1000))) },
    );
  }

  async alarm() {
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
  }
}
