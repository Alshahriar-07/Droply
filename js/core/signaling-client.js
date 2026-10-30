/**
 * Client for the Droply signaling service (Cloudflare Worker + Durable Object).
 *
 * The signaling service only relays room state and WebRTC negotiation data.
 * File bytes never touch it: they travel over the peer connection below.
 */

import { signalingSocketUrl, signalingUrl } from "../config.js";
import { isValidCode } from "../utils/validation.js";

const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 3;

export class SignalingError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, retryable?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "SignalingError";
    this.code = options.code ?? "signaling_error";
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
  }
}

const ERROR_MESSAGES = {
  room_not_found: "That code wasn't found. Check the six characters and try again.",
  room_expired: "This transfer has expired. Ask the sender to create a new one.",
  room_occupied: "This transfer already has a receiver connected.",
  room_closed: "This transfer has already ended.",
  invalid_code: "That transfer code isn't valid.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  origin_rejected: "This site isn't allowed to use the signaling service.",
  bad_request: "The signaling service rejected the request.",
  server_error: "The signaling service had a problem. Try again.",
  network_error: "Can't reach the Droply signaling service. Check your connection.",
  invalid_response: "The signaling service sent an unexpected response.",
};

function messageForCode(code, fallback) {
  return ERROR_MESSAGES[code] ?? fallback ?? "Something went wrong while connecting.";
}

export class SignalingClient extends EventTarget {
  constructor() {
    super();
    /** @type {WebSocket|null} */
    this.socket = null;
    this.code = null;
    this.token = null;
    this.closedByUs = false;
    this.reconnectAttempts = 0;
    this.heartbeat = 0;
    this.pongTimeout = 0;
    this.reconnectTimer = 0;
    this.ready = false;
    /** Set once the server ends the room; the socket must never retry. */
    this.terminal = false;
  }

  /* ------------------------------------------------------------------------
     HTTP API
     ------------------------------------------------------------------------ */

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown }} [options]
   */
  async #request(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(signalingUrl(path), {
        method: options.method ?? "GET",
        headers: options.body ? { "content-type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "strict-origin-when-cross-origin",
      });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      throw new SignalingError(
        aborted ? "The signaling service timed out." : messageForCode("network_error"),
        { code: "network_error", retryable: true },
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
      const code = payload?.error ?? (response.status >= 500 ? "server_error" : "bad_request");
      throw new SignalingError(messageForCode(code, payload?.message), {
        code,
        status: response.status,
        retryable: response.status >= 500 || code === "rate_limited",
      });
    }
    if (!payload || typeof payload !== "object") {
      throw new SignalingError(messageForCode("invalid_response"), { code: "invalid_response" });
    }
    return payload;
  }

  /** Creates a one-time waiting room and returns its code + role token. */
  async createRoom() {
    const data = await this.#request("/api/rooms", {
      method: "POST",
      body: { role: "sender" },
    });
    const code = String(data.code ?? "");
    if (!isValidCode(code) || typeof data.token !== "string" || data.token.length < 20) {
      throw new SignalingError(messageForCode("invalid_response"), { code: "invalid_response" });
    }
    return {
      code,
      token: data.token,
      expiresAt: data.expiresAt ?? null,
      ttlSeconds: Number(data.ttlSeconds) || 600,
    };
  }

  /** Joins an existing room as the receiver. */
  async joinRoom(code) {
    if (!isValidCode(code)) {
      throw new SignalingError(messageForCode("invalid_code"), { code: "invalid_code" });
    }
    const data = await this.#request(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: { role: "receiver" },
    });
    if (typeof data.token !== "string" || data.token.length < 20) {
      throw new SignalingError(messageForCode("invalid_response"), { code: "invalid_response" });
    }
    return {
      token: data.token,
      expiresAt: data.expiresAt ?? null,
      ttlSeconds: Number(data.ttlSeconds) || 600,
    };
  }

  /* ------------------------------------------------------------------------
     WebSocket
     ------------------------------------------------------------------------ */

  /**
   * Opens the room socket. Emits:
   *  - "open" when the socket is established
   *  - "ready" with the room snapshot
   *  - "message" for every server message (detail = message)
   *  - "reconnecting" { attempt, delay }
   *  - "close" { code, reason, byUs }
   *  - "error" { error }
   */
  connect({ code, token }) {
    this.code = code;
    this.token = token;
    this.closedByUs = false;
    this.terminal = false;
    this.reconnectAttempts = 0;
    this.#openSocket();
  }

  #openSocket() {
    window.clearTimeout(this.reconnectTimer);
    let socket;
    try {
      socket = new WebSocket(signalingSocketUrl(this.code, this.token));
    } catch (error) {
      this.dispatchEvent(new CustomEvent("error", { detail: { error } }));
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.ready = false;
      this.dispatchEvent(new Event("open"));
      this.#startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || typeof message.type !== "string") return;

      if (message.type === "pong") {
        window.clearTimeout(this.pongTimeout);
        return;
      }
      if (message.type === "ready") {
        this.ready = true;
        this.reconnectAttempts = 0;
        this.dispatchEvent(new CustomEvent("ready", { detail: message }));
      }
      if (message.type === "room_closed") {
        // The room is gone (completed, cancelled, rejected or expired): a
        // reconnection could only fail, so stop retrying.
        this.terminal = true;
      }
      if (message.type === "error") {
        this.dispatchEvent(
          new CustomEvent("error", {
            detail: {
              error: new SignalingError(messageForCode(message.code, message.message), {
                code: message.code ?? "signaling_error",
              }),
            },
          }),
        );
      }
      this.dispatchEvent(new CustomEvent("message", { detail: message }));
    });

    socket.addEventListener("close", (event) => {
      const byUs = this.closedByUs;
      // 4001 means another socket replaced this one for the same role.
      if (event.code === 4001) this.terminal = true;
      this.#stopHeartbeat();
      this.ready = false;
      this.socket = null;
      this.dispatchEvent(
        new CustomEvent("close", {
          detail: { code: event.code, reason: event.reason, byUs },
        }),
      );
      if (!byUs) this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // A close event always follows; reconnect logic lives there.
    });
  }

  #scheduleReconnect() {
    if (this.closedByUs || this.terminal) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    this.reconnectAttempts += 1;
    const delay = 700 * 2 ** (this.reconnectAttempts - 1);
    this.dispatchEvent(
      new CustomEvent("reconnecting", {
        detail: { attempt: this.reconnectAttempts, delay },
      }),
    );
    this.reconnectTimer = window.setTimeout(() => {
      if (!this.closedByUs && this.code && this.token) this.#openSocket();
    }, delay);
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      try {
        this.socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        return;
      }
      window.clearTimeout(this.pongTimeout);
      this.pongTimeout = window.setTimeout(() => {
        // Dead socket: close it so the reconnect path runs.
        this.socket?.close();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  #stopHeartbeat() {
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.pongTimeout);
    this.heartbeat = 0;
    this.pongTimeout = 0;
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {boolean}
   */
  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Closes the socket without reconnecting. */
  close() {
    this.closedByUs = true;
    this.#stopHeartbeat();
    window.clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close(1000, "client-closed");
      } catch {
        /* already closed */
      }
    }
    this.code = null;
    this.token = null;
  }
}
