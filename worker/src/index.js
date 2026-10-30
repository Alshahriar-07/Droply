/**
 * Droply signaling Worker.
 *
 * Routes:
 *   POST /api/rooms                     create a one-time room (sender)
 *   POST /api/rooms/:code/join          claim the single receiver slot
 *   GET  /api/rooms/:code/socket        WebSocket upgrade (token required)
 *   POST /api/nearby/register           opt-in nearby presence record
 *   GET  /api/nearby/socket             nearby presence WebSocket (token required)
 *   POST /api/pair                      create a five-minute pairing session
 *   POST /api/pair/:code/status         owner-only session status (poll)
 *   POST /api/pair/:code/join           redeem a code exactly once
 *   POST /api/pair/:code/regenerate     rotate a code that hasn't been used
 *   POST /api/pair/:code/consume        end a session early
 *   GET  /api/health                    liveness probe
 *
 * The Worker validates origin, method, payload shape and rate limits, then
 * hands per-room coordination to the Room Durable Object. No file bytes are
 * accepted here — the only body shapes are small JSON objects.
 */

import { Room, RateLimiter } from "./room.js";
import { Presence, sanitizeAvatar, sanitizeDeviceType, sanitizeDisplayName } from "./presence.js";
import {
  Pairing,
  PAIRING_TTL_SECONDS,
  randomPairingCode,
  sanitizePeer,
  newOwnerToken,
} from "./pairing.js";
import { hashToken, jsonResponse } from "./util.js";

export { Room, RateLimiter, Presence, Pairing };

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_JSON_BYTES = 2048;

/** Rate limits per hashed client IP. */
const LIMITS = {
  create: { limit: 12, windowMs: 10 * 60_000 },
  join: { limit: 40, windowMs: 5 * 60_000 },
  socket: { limit: 120, windowMs: 5 * 60_000 },
  nearby: { limit: 30, windowMs: 10 * 60_000 },
  pairCreate: { limit: 10, windowMs: 10 * 60_000 },
  // A code lives five minutes; 20 attempts per address makes guessing one
  // astronomically unlikely while still forgiving honest typos.
  pairJoin: { limit: 20, windowMs: 5 * 60_000 },
  pairStatus: { limit: 400, windowMs: 5 * 60_000 },
  pairMutate: { limit: 20, windowMs: 10 * 60_000 },
};

/* --------------------------------------------------------------------------
   Utilities
   -------------------------------------------------------------------------- */

function allowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function isOriginAllowed(env, origin) {
  const list = allowedOrigins(env);
  if (list.includes("*")) return true;
  if (!origin) return true; // non-browser client (curl, monitoring)
  return list.includes(origin);
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function apiError(error, status, origin, extra = {}) {
  return withCors(jsonResponse({ error, ...extra }, status), origin);
}

/** Uniform, cryptographically secure room code. */
function randomCode() {
  let code = "";
  const max = 256 - (256 % CODE_ALPHABET.length);
  while (code.length < 6) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= max) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === 6) break;
    }
  }
  return code;
}

/** Privacy-preserving client identifier for rate limiting. */
async function hashClientId(request, env, scope = "rate-limit") {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const salt = String(env.IP_SALT ?? "droply-signaling");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${scope}|${ip}|${salt}`),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readJson(request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return { error: "unsupported_media_type" };

  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) return { error: "payload_too_large" };
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "bad_request" };
    return { body };
  } catch {
    return { error: "bad_request" };
  }
}

/** @returns {Promise<{allowed: boolean, retryAfter?: number}>} */
async function checkRateLimit(env, clientId, bucket) {
  const config = LIMITS[bucket];
  if (!config || !env.RATE_LIMITER) return { allowed: true };

  try {
    const id = env.RATE_LIMITER.idFromName(`${clientId}:${bucket}`);
    const stub = env.RATE_LIMITER.get(id);
    const response = await stub.fetch("https://rate-limit/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      return { allowed: false, retryAfter: Number(data.retryAfter) || 60 };
    }
    return { allowed: response.ok };
  } catch (error) {
    // A limiter outage must not take signaling down; log and continue.
    console.error("[rate-limit] unavailable", error?.message);
    return { allowed: true };
  }
}

function roomStub(env, code) {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

/**
 * Nearby presence namespace: a hash of the caller's public network address, so
 * devices behind the same router meet each other and nothing else. The key is
 * derived and consumed inside the Worker and never returned to a client, so no
 * IP address (or hash of one) is ever exposed.
 */
async function presenceStub(request, env) {
  if (!env.PRESENCE) return null;
  const group = await hashClientId(request, env, "nearby-group");
  return env.PRESENCE.get(env.PRESENCE.idFromName(group));
}

function pairingStub(env, code) {
  return env.PAIRING.get(env.PAIRING.idFromName(code));
}

/* --------------------------------------------------------------------------
   Routes
   -------------------------------------------------------------------------- */

async function handleCreate(request, env) {
  const clientId = await hashClientId(request, env);
  const rate = await checkRateLimit(env, clientId, "create");
  if (!rate.allowed) {
    return apiError("rate_limited", 429, request.headers.get("Origin"), {
      message: "Too many transfers created from this network. Try again shortly.",
    });
  }

  const parsed = await readJson(request);
  if (parsed.error === "unsupported_media_type") return apiError("bad_request", 415, request.headers.get("Origin"));
  if (parsed.error === "payload_too_large") return apiError("bad_request", 413, request.headers.get("Origin"));
  if (parsed.error) return apiError("bad_request", 400, request.headers.get("Origin"));

  if (parsed.body.role !== undefined && parsed.body.role !== "sender") {
    return apiError("bad_request", 400, request.headers.get("Origin"), {
      message: "Only senders can create a room.",
    });
  }

  const ttlSeconds = Math.min(3600, Math.max(120, Number(env.ROOM_TTL_SECONDS) || 600));
  const origin = request.headers.get("Origin");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomCode();
    let response;
    try {
      response = await roomStub(env, code).fetch("https://room/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, ttlSeconds }),
      });
    } catch (error) {
      console.error("[room] init failed", error?.message);
      return apiError("server_error", 500, origin);
    }

    if (response.status === 409) continue; // code already in use, try another
    if (!response.ok) {
      console.error("[room] init rejected", response.status);
      return apiError("server_error", 502, origin);
    }

    const data = await response.json();
    return withCors(
      jsonResponse({
        code: data.code,
        token: data.token,
        expiresAt: data.expiresAt,
        ttlSeconds: data.ttlSeconds,
      }),
      origin,
    );
  }

  return apiError("server_error", 503, origin, {
    message: "Could not allocate a room code. Try again.",
  });
}

async function handleJoin(request, env, code) {
  const origin = request.headers.get("Origin");
  const clientId = await hashClientId(request, env);
  const rate = await checkRateLimit(env, clientId, "join");
  if (!rate.allowed) {
    return apiError("rate_limited", 429, origin, {
      message: "Too many attempts. Wait a moment and try again.",
    });
  }

  const parsed = await readJson(request);
  if (parsed.error === "unsupported_media_type") return apiError("bad_request", 415, origin);
  if (parsed.error) return apiError("bad_request", 400, origin);
  if (parsed.body.role !== undefined && parsed.body.role !== "receiver") {
    return apiError("bad_request", 400, origin);
  }

  let response;
  try {
    response = await roomStub(env, code).fetch("https://room/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    console.error("[room] join failed", error?.message);
    return apiError("server_error", 500, origin);
  }

  if (response.status === 404) return apiError("room_not_found", 404, origin);
  if (response.status === 410) return apiError("room_expired", 410, origin);
  if (response.status === 409) return apiError("room_occupied", 409, origin);
  if (!response.ok) return apiError("server_error", 502, origin);

  const data = await response.json();
  return withCors(
    jsonResponse({
      code: data.code,
      token: data.token,
      expiresAt: data.expiresAt,
      ttlSeconds: data.ttlSeconds,
    }),
    origin,
  );
}

async function handleSocket(request, env, code) {
  const origin = request.headers.get("Origin");
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token || token.length > 128) return apiError("unauthorized", 401, origin);

  const clientId = await hashClientId(request, env);
  const rate = await checkRateLimit(env, clientId, "socket");
  if (!rate.allowed) return apiError("rate_limited", 429, origin);

  const target = new URL(request.url);
  target.pathname = "/socket";
  target.searchParams.set("token", token);

  try {
    // Forward the upgrade to the room; it returns the 101 with the client socket.
    return await roomStub(env, code).fetch(new Request(target.toString(), request));
  } catch (error) {
    console.error("[room] socket failed", error?.message);
    return apiError("server_error", 500, origin);
  }
}

/* --------------------------------------------------------------------------
   Nearby presence
   -------------------------------------------------------------------------- */

/** Registers a short-lived, opt-in presence record for nearby discovery. */
async function handleNearbyRegister(request, env) {
  const origin = request.headers.get("Origin");
  const clientId = await hashClientId(request, env);
  const rate = await checkRateLimit(env, clientId, "nearby");
  if (!rate.allowed) {
    return apiError("rate_limited", 429, origin, {
      message: "Too many nearby sessions. Wait a moment and try again.",
    });
  }

  const parsed = await readJson(request);
  if (parsed.error === "unsupported_media_type") return apiError("bad_request", 415, origin);
  if (parsed.error) return apiError("bad_request", 400, origin);

  const deviceId = String(parsed.body.deviceId ?? "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return apiError("bad_request", 400, origin);

  const stub = await presenceStub(request, env);
  if (!stub) return apiError("server_error", 503, origin);

  let response;
  try {
    response = await stub.fetch("https://presence/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId,
        name: sanitizeDisplayName(parsed.body.name),
        deviceType: sanitizeDeviceType(parsed.body.deviceType),
        platform: sanitizeDeviceType(parsed.body.platform),
        browser: sanitizeDeviceType(parsed.body.browser),
        avatar: sanitizeAvatar(parsed.body.avatar),
        available: parsed.body.available !== false,
      }),
    });
  } catch (error) {
    console.error("[nearby] register failed", error?.message);
    return apiError("server_error", 500, origin);
  }

  if (response.status === 429) {
    return apiError("presence_full", 429, origin, {
      message: "There are too many nearby devices right now. Try again shortly.",
    });
  }
  if (!response.ok) return apiError("server_error", 502, origin);

  const data = await response.json();
  return withCors(
    jsonResponse({
      peerId: data.peerId,
      token: data.token,
      expiresAt: data.expiresAt,
      ttlSeconds: data.ttlSeconds,
    }),
    origin,
  );
}

async function handleNearbySocket(request, env) {
  const origin = request.headers.get("Origin");
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token || token.length > 128) return apiError("unauthorized", 401, origin);

  const clientId = await hashClientId(request, env);
  const rate = await checkRateLimit(env, clientId, "nearby");
  if (!rate.allowed) return apiError("rate_limited", 429, origin);

  const stub = await presenceStub(request, env);
  if (!stub) return apiError("server_error", 503, origin);

  const target = new URL(request.url);
  target.pathname = "/socket";
  target.searchParams.set("token", token);

  try {
    return await stub.fetch(new Request(target.toString(), request));
  } catch (error) {
    console.error("[nearby] socket failed", error?.message);
    return apiError("server_error", 500, origin);
  }
}

/* --------------------------------------------------------------------------
   Device pairing
   -------------------------------------------------------------------------- */

/**
 * Creates a five-minute pairing session. The code is allocated here (not in a
 * client) so collisions are resolved against live sessions; the owner token is
 * returned once and only its hash is stored.
 */
async function handlePairCreate(request, env) {
  const origin = request.headers.get("Origin");
  if (!env.PAIRING) return apiError("server_error", 503, origin);

  const clientId = await hashClientId(request, env, "pair");
  const rate = await checkRateLimit(env, clientId, "pairCreate");
  if (!rate.allowed) {
    return apiError("rate_limited", 429, origin, {
      message: "Too many pairing codes requested. Wait a minute and try again.",
    });
  }

  const parsed = await readJson(request);
  if (parsed.error === "unsupported_media_type") return apiError("bad_request", 415, origin);
  if (parsed.error) return apiError("bad_request", 400, origin);

  const owner = sanitizePeer(parsed.body);
  if (!owner) {
    return apiError("bad_request", 400, origin, { message: "Pairing details were incomplete." });
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomPairingCode();
    const token = newOwnerToken();
    const tokenHash = await hashToken(token);
    let response;
    try {
      response = await pairingStub(env, code).fetch("https://pair/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, owner, tokenHash, ttlSeconds: PAIRING_TTL_SECONDS }),
      });
    } catch (error) {
      console.error("[pair] init failed", error?.message);
      return apiError("server_error", 500, origin);
    }

    if (response.status === 409) continue; // code already live, try another
    if (!response.ok) {
      console.error("[pair] init rejected", response.status);
      return apiError("server_error", 502, origin);
    }

    const data = await response.json();
    return withCors(
      jsonResponse({
        code: data.code,
        token,
        expiresAt: data.expiresAt,
        ttlSeconds: data.ttlSeconds,
      }),
      origin,
    );
  }

  return apiError("server_error", 503, origin, {
    message: "Could not allocate a pairing code. Try again.",
  });
}

async function pairSessionRequest(request, env, code, action, body, bucket = "pairMutate") {
  const clientId = await hashClientId(request, env, "pair");
  const rate = await checkRateLimit(env, clientId, bucket);
  if (!rate.allowed) return { response: null, rateLimited: true };

  try {
    const response = await pairingStub(env, code).fetch(`https://pair/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, rateLimited: false };
  } catch (error) {
    console.error(`[pair] ${action} failed`, error?.message);
    return { response: null, rateLimited: false, error: true };
  }
}

async function handlePairStatus(request, env, code) {
  const origin = request.headers.get("Origin");
  const parsed = await readJson(request);
  if (parsed.error) {
    return apiError("bad_request", parsed.error === "unsupported_media_type" ? 415 : 400, origin);
  }

  const token = String(parsed.body.token ?? "");
  if (!token || token.length > 128) return apiError("unauthorized", 401, origin);

  const { response, rateLimited, error } = await pairSessionRequest(request, env, code, "status", { token }, "pairStatus");
  if (rateLimited) return apiError("rate_limited", 429, origin);
  if (!response) return apiError("server_error", error ? 500 : 502, origin);

  const data = await response.json().catch(() => ({}));
  if (response.status === 404) return apiError("pair_not_found", 404, origin);
  if (response.status === 410) return apiError("pair_expired", 410, origin);
  if (response.status === 401) return apiError("unauthorized", 401, origin);
  if (!response.ok) return apiError("server_error", 502, origin);

  return withCors(jsonResponse(data), origin);
}

async function handlePairJoin(request, env, code) {
  const origin = request.headers.get("Origin");
  const parsed = await readJson(request);
  if (parsed.error === "unsupported_media_type") return apiError("bad_request", 415, origin);
  if (parsed.error) return apiError("bad_request", 400, origin);

  const peer = sanitizePeer(parsed.body.peer);
  if (!peer) return apiError("bad_request", 400, origin, { message: "Pairing details were incomplete." });

  const { response, rateLimited, error } = await pairSessionRequest(request, env, code, "join", { peer }, "pairJoin");
  if (rateLimited) {
    return apiError("rate_limited", 429, origin, {
      message: "Too many pairing attempts. Wait a minute and try again.",
    });
  }
  if (!response) return apiError("server_error", error ? 500 : 502, origin);

  const data = await response.json().catch(() => ({}));
  if (response.status === 404) return apiError("pair_not_found", 404, origin);
  if (response.status === 410) return apiError("pair_expired", 410, origin);
  if (response.status === 409) {
    const reason = data.error === "pair_self" ? "pair_self" : "pair_used";
    return apiError(reason, 409, origin);
  }
  if (!response.ok) return apiError("server_error", 502, origin);

  return withCors(jsonResponse(data), origin);
}

async function handlePairRegenerate(request, env, code) {
  const origin = request.headers.get("Origin");
  const parsed = await readJson(request);
  if (parsed.error === "unsupported_media_type") return apiError("bad_request", 415, origin);
  if (parsed.error) return apiError("bad_request", 400, origin);

  const token = String(parsed.body.token ?? "");
  if (!token || token.length > 128) return apiError("unauthorized", 401, origin);

  const verify = await pairSessionRequest(request, env, code, "verify", { token }, "pairMutate");
  if (verify.rateLimited) return apiError("rate_limited", 429, origin);
  if (!verify.response) return apiError("server_error", 500, origin);
  if (verify.response.status === 404 || verify.response.status === 410) {
    return apiError("pair_not_found", 404, origin);
  }
  if (verify.response.status === 401) return apiError("unauthorized", 401, origin);
  if (!verify.response.ok) return apiError("server_error", 502, origin);

  const verified = await verify.response.json();
  if (verified.joined) return apiError("pair_joined", 409, origin);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nextCode = randomPairingCode();
    const nextToken = newOwnerToken();
    const nextHash = await hashToken(nextToken);
    let created;
    try {
      created = await pairingStub(env, nextCode).fetch("https://pair/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: nextCode,
          owner: verified.owner,
          tokenHash: nextHash,
          ttlSeconds: PAIRING_TTL_SECONDS,
        }),
      });
    } catch (error) {
      console.error("[pair] rotate failed", error?.message);
      return apiError("server_error", 500, origin);
    }
    if (created.status === 409) continue;
    if (!created.ok) return apiError("server_error", 502, origin);

    const data = await created.json();
    // The old code must stop working immediately; a failure here only leaves
    // it to expire on its own, which is safe.
    try {
      await pairingStub(env, code).fetch("https://pair/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      /* the old session expires within five minutes regardless */
    }

    return withCors(
      jsonResponse({ code: data.code, token: nextToken, expiresAt: data.expiresAt, ttlSeconds: data.ttlSeconds }),
      origin,
    );
  }

  return apiError("server_error", 503, origin);
}

async function handlePairConsume(request, env, code) {
  const origin = request.headers.get("Origin");
  const parsed = await readJson(request);
  if (parsed.error) return apiError("bad_request", 400, origin);

  const token = String(parsed.body.token ?? "");
  if (!token || token.length > 128) return apiError("unauthorized", 401, origin);

  const { response, rateLimited, error } = await pairSessionRequest(request, env, code, "consume", { token }, "pairMutate");
  if (rateLimited) return apiError("rate_limited", 429, origin);
  if (!response) return apiError("server_error", error ? 500 : 502, origin);
  if (response.status === 401) return apiError("unauthorized", 401, origin);
  if (!response.ok) return apiError("server_error", 502, origin);

  return withCors(jsonResponse({ ok: true }), origin);
}

/* --------------------------------------------------------------------------
   Entry point
   -------------------------------------------------------------------------- */

export default {
  /**
   * @param {Request} request
   * @param {{ ALLOWED_ORIGINS?: string, ROOM_TTL_SECONDS?: string, IP_SALT?: string, ROOM: DurableObjectNamespace, RATE_LIMITER?: DurableObjectNamespace, PRESENCE?: DurableObjectNamespace, PAIRING?: DurableObjectNamespace }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      if (!isOriginAllowed(env, origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isOriginAllowed(env, origin)) {
      return apiError("origin_rejected", 403, origin, {
        message: "This origin is not allowed to use this signaling service.",
      });
    }

    if (url.pathname === "/api/health") {
      return withCors(
        jsonResponse({ ok: true, service: "droply-signaling", time: new Date().toISOString() }),
        origin,
      );
    }

    try {
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        return await handleCreate(request, env);
      }

      const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/join$/);
      if (joinMatch && request.method === "POST") {
        const code = joinMatch[1].toUpperCase();
        if (!CODE_PATTERN.test(code)) return apiError("invalid_code", 400, origin);
        return await handleJoin(request, env, code);
      }

      if (url.pathname === "/api/nearby/register" && request.method === "POST") {
        return await handleNearbyRegister(request, env);
      }

      if (url.pathname === "/api/nearby/socket") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return apiError("upgrade_required", 426, origin);
        }
        return await handleNearbySocket(request, env);
      }

      if (url.pathname === "/api/pair" && request.method === "POST") {
        return await handlePairCreate(request, env);
      }

      const pairMatch = url.pathname.match(/^\/api\/pair\/([A-Za-z0-9]{6})\/(status|join|regenerate|consume)$/);
      if (pairMatch && request.method === "POST") {
        const code = pairMatch[1].toUpperCase();
        if (!CODE_PATTERN.test(code)) return apiError("invalid_code", 400, origin);
        if (pairMatch[2] === "status") return await handlePairStatus(request, env, code);
        if (pairMatch[2] === "join") return await handlePairJoin(request, env, code);
        if (pairMatch[2] === "regenerate") return await handlePairRegenerate(request, env, code);
        return await handlePairConsume(request, env, code);
      }

      const socketMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/socket$/);
      if (socketMatch) {
        const code = socketMatch[1].toUpperCase();
        if (!CODE_PATTERN.test(code)) return apiError("invalid_code", 400, origin);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return apiError("upgrade_required", 426, origin);
        }
        return await handleSocket(request, env, code);
      }

      return apiError("not_found", 404, origin);
    } catch (error) {
      console.error("[worker] unhandled", error?.stack ?? error?.message);
      return apiError("server_error", 500, origin);
    }
  },
};
