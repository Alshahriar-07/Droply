/**
 * Nearby presence client.
 *
 * Discovery is opt-in and relay-based: this client registers a short-lived
 * presence record with the Droply Worker, receives the other Droply devices
 * that share the same network, and can relay a signed transfer invite to one
 * of them. File bytes never travel through this channel.
 *
 * The browser cannot scan a LAN, so a device only appears when its owner has
 * explicitly started Nearby mode on some device behind the same public address.
 */

import { nearbySocketUrl, signalingUrl } from "../config.js";
import { SignalingError } from "./signaling-client.js";

const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 25_000;
const PONG_TIMEOUT_MS = 15_000;
const MAX_RECONNECTS = 2;

const MESSAGES = {
  presence_full: "There are too many nearby devices right now.",
  rate_limited: "Too many nearby attempts. Wait a moment and try again.",
  network_error: "Can't reach Droply's nearby service. Check your connection.",
  origin_rejected: "This site isn't allowed to use the nearby service.",
  unauthorized: "The nearby session expired. Start discovery again.",
  server_error: "The nearby service had a problem. Try again.",
};

function messageFor(code) {
  return MESSAGES[code] ?? "Nearby discovery failed.";
}

export class PresenceClient extends EventTarget {
  /** @param {{ identity: { deviceId: string, name: string, deviceType: string } }} options */
  constructor({ identity }) {
    super();
    this.identity = identity;
    this.peerId = null;
    this.token = null;
    this.socket = null;
    this.peers = [];
    this.available = true;
    this.stopped = true;
    this.reconnects = 0;
    this.heartbeat = 0;
    this.pongTimer = 0;
    this.reconnectTimer = 0;
    this.starting = null;
  }

  get isOnline() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.peerId);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setPhase(phase, detail = {}) {
    this.#emit("status", { phase, ...detail });
  }

  /** Registers a presence record and opens the relay socket. */
  async start() {
    if (this.isOnline) return this;
    if (this.starting) return this.starting;
    this.stopped = false;
    this.#setPhase("starting");

    this.starting = (async () => {
      const registered = await this.#register();
      this.peerId = registered.peerId;
      this.token = registered.token;
      // Stop pressed while the request was in flight: release the record
      // instead of publishing a session the user already switched off.
      if (this.stopped) {
        this.#discardSession();
        return this;
      }
      this.#openSocket();
      return this;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #register() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(signalingUrl("/api/nearby/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: this.identity.deviceId,
          name: this.identity.name,
          deviceType: this.identity.deviceType,
          platform: this.identity.platform,
          browser: this.identity.browser,
          avatar: this.identity.avatar,
          available: this.available,
        }),
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "strict-origin-when-cross-origin",
      });
    } catch {
      this.#setPhase("offline");
      throw new SignalingError(messageFor("network_error"), { code: "network_error", retryable: true });
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
      const code = payload?.error ?? (response.status >= 500 ? "server_error" : "unauthorized");
      this.#setPhase("offline");
      throw new SignalingError(messageFor(code), {
        code,
        status: response.status,
        retryable: code === "rate_limited",
      });
    }
    if (!payload || typeof payload.peerId !== "string" || typeof payload.token !== "string") {
      this.#setPhase("offline");
      throw new SignalingError(messageFor("server_error"), { code: "server_error" });
    }
    return payload;
  }

  #openSocket() {
    let socket;
    try {
      socket = new WebSocket(nearbySocketUrl(this.token));
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnects = 0;
      this.#setPhase("online");
      this.#startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message.type !== "string") return;

      switch (message.type) {
        case "ready":
          window.clearTimeout(this.pongTimer);
          if (typeof message.peerId === "string") this.peerId = message.peerId;
          this.#updatePeers(message.peers);
          break;
        case "presence":
          window.clearTimeout(this.pongTimer);
          this.#updatePeers(message.peers);
          break;
        case "pong":
          window.clearTimeout(this.pongTimer);
          break;
        case "invite":
          this.#emit("invite", { from: message.from ?? {}, invite: message.invite ?? {} });
          break;
        case "invite-sent":
          this.#emit("invite-sent", { delivered: Boolean(message.delivered) });
          break;
        case "invite-response":
          this.#emit("invite-response", {
            from: message.from ?? {},
            accepted: message.accepted === true,
          });
          break;
        case "error":
          this.#emit("error", {
            error: new SignalingError(messageFor(message.code), { code: message.code ?? "server_error" }),
          });
          break;
        default:
          break;
      }
    });

    socket.addEventListener("close", (event) => {
      // A socket replaced by refreshIdentity() must not drive reconnection.
      if (this.socket !== socket) return;
      this.#stopHeartbeat();
      this.socket = null;
      if (this.stopped) {
        this.#setPhase("offline");
        return;
      }
      // 4001 means another nearby session replaced this one.
      if (event.code === 4001 || event.code === 4008 || event.code === 4004) {
        this.stopped = true;
        this.#setPhase("offline");
        return;
      }
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      /* the close handler owns recovery */
    });
  }

  /**
   * Releases a record that was registered after the user stopped discovery.
   * The socket is opened once only to send `leave`, which deletes the record
   * immediately instead of waiting out the two-minute lease.
   */
  #discardSession() {
    const token = this.token;
    this.token = null;
    this.peerId = null;
    if (!token) return;
    try {
      const socket = new WebSocket(nearbySocketUrl(token));
      const finish = () => {
        try {
          socket.close(1000, "cancelled");
        } catch {
          /* already closed */
        }
      };
      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify({ type: "leave" }));
        } catch {
          /* the lease will expire anyway */
        }
        finish();
      });
      socket.addEventListener("error", finish);
    } catch {
      /* a failed cleanup cannot extend the two-minute lease */
    }
  }

  #updatePeers(peers) {
    if (!Array.isArray(peers)) return;
    this.peers = peers
      .filter((peer) => peer && typeof peer.peerId === "string" && peer.peerId !== this.peerId)
      .map((peer) => ({
        peerId: String(peer.peerId),
        deviceId: String(peer.deviceId ?? ""),
        name: String(peer.name ?? "Droply device").slice(0, 40),
        deviceType: String(peer.deviceType ?? "").slice(0, 40),
        platform: String(peer.platform ?? "").slice(0, 24),
        browser: String(peer.browser ?? "").slice(0, 24),
        avatar: String(peer.avatar ?? "generic"),
        available: peer.available !== false,
      }));
    this.#emit("peers", { peers: this.peers });
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      this.stopped = true;
      this.#setPhase("offline");
      return;
    }
    this.reconnects += 1;
    this.#setPhase("reconnecting", { attempt: this.reconnects });
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(async () => {
      if (this.stopped) return;
      try {
        const registered = await this.#register();
        this.peerId = registered.peerId;
        this.token = registered.token;
        this.#openSocket();
      } catch {
        this.#setPhase("offline");
      }
    }, 900 * this.reconnects);
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
      window.clearTimeout(this.pongTimer);
      this.pongTimer = window.setTimeout(() => {
        // No answer: drop the socket so the reconnect path can run.
        try {
          this.socket?.close();
        } catch {
          /* already closed */
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  #stopHeartbeat() {
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.pongTimer);
    this.heartbeat = 0;
    this.pongTimer = 0;
  }

  #send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Opt in/out of appearing as available without leaving discovery. */
  setAvailable(available) {
    this.available = Boolean(available);
    return this.#send({ type: "availability", available: this.available });
  }

  /** @param {string} peerId @param {object} invite */
  sendInvite(peerId, invite) {
    return this.#send({ type: "invite", to: peerId, invite });
  }

  /** @param {string} peerId @param {boolean} accepted */
  respondInvite(peerId, accepted) {
    return this.#send({ type: "invite-response", to: peerId, accepted: Boolean(accepted) });
  }

  /**
   * Re-publishes the record after a profile edit so nearby devices and signed
   * invites see the new name and avatar in this session, without a reload.
   */
  async refreshIdentity() {
    if (this.stopped) return this;
    const wasOnline = this.isOnline;
    this.#stopHeartbeat();
    window.clearTimeout(this.reconnectTimer);
    const previous = this.socket;
    this.socket = null;
    try {
      previous?.close(1000, "profile-updated");
    } catch {
      /* already closed */
    }
    if (!wasOnline) return this;

    this.#setPhase("starting");
    try {
      const registered = await this.#register();
      this.peerId = registered.peerId;
      this.token = registered.token;
      if (this.stopped) {
        this.#discardSession();
        return this;
      }
      this.#openSocket();
    } catch {
      this.stopped = true;
      this.#setPhase("offline");
    }
    return this;
  }

  /** Leaves the presence group immediately; nothing is kept on the server. */
  stop() {
    if (this.stopped) return;
    this.#send({ type: "leave" });
    this.stopped = true;
    this.#stopHeartbeat();
    window.clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    this.peerId = null;
    this.token = null;
    this.peers = [];
    this.reconnects = 0;
    try {
      socket?.close(1000, "left");
    } catch {
      /* already closed */
    }
    this.#setPhase("offline");
    this.#emit("peers", { peers: [] });
  }
}
