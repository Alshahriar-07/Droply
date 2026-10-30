/**
 * Droply signaling Worker.
 *
 * Routes:
 *   POST /api/rooms                     create a one-time room (sender)
 *   POST /api/rooms/:code/join          claim the single receiver slot
 *   GET  /api/rooms/:code/socket        WebSocket upgrade (token required)
 *   GET  /api/health                    liveness probe
 *
 * The Worker validates origin, method, payload shape and rate limits, then
 * hands per-room coordination to the Room Durable Object. No file bytes are
 * accepted here — the only body shapes are small JSON objects.
 */

import { Room, RateLimiter, jsonResponse } from "./room.js";

export { Room, RateLimiter };

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_JSON_BYTES = 2048;

/** Rate limits per hashed client IP. */
const LIMITS = {
  create: { limit: 12, windowMs: 10 * 60_000 },
  join: { limit: 40, windowMs: 5 * 60_000 },
  socket: { limit: 120, windowMs: 5 * 60_000 },
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
async function hashClientId(request, env) {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const salt = String(env.IP_SALT ?? "droply-signaling");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${salt}`));
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
   Entry point
   -------------------------------------------------------------------------- */

export default {
  /**
   * @param {Request} request
   * @param {{ ALLOWED_ORIGINS?: string, ROOM_TTL_SECONDS?: string, IP_SALT?: string, ROOM: DurableObjectNamespace, RATE_LIMITER?: DurableObjectNamespace }} env
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
