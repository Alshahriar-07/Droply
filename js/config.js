/**
 * Runtime configuration.
 *
 * Everything here can be overridden without rebuilding, by editing the
 * <meta> tags in index.html (or this file for a fork):
 *
 *   droply-signaling        Base URL of the signaling Worker.
 *   droply-turn-url         Comma separated TURN URLs (optional).
 *   droply-turn-username    TURN username (optional).
 *   droply-turn-credential  TURN credential (optional).
 *
 * Leaving `droply-signaling` empty means "same origin", which is what a
 * reverse-proxied deployment (droply.example.com/api/* -> Worker) uses.
 */

const readMeta = (name) => {
  const tag = document.querySelector(`meta[name="${name}"]`);
  const value = tag?.getAttribute("content");
  return value ? value.trim() : "";
};

const isLocalHost = () =>
  ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

/** Signaling server used for room creation and WebRTC signaling. */
function resolveSignalingBaseUrl() {
  const configured = readMeta("droply-signaling");
  if (configured) return configured.replace(/\/+$/, "");
  // `wrangler dev` serves the signaling Worker on port 8787 by default.
  if (isLocalHost()) return `${window.location.protocol}//${window.location.hostname}:8787`;
  return "";
}

/** Builds the ICE server list. STUN is free; TURN is optional and modular. */
function resolveIceServers() {
  const servers = [
    {
      urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
    },
  ];

  const turnUrl = readMeta("droply-turn-url");
  if (turnUrl) {
    const urls = turnUrl
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean);
    if (urls.length) {
      servers.push({
        urls,
        username: readMeta("droply-turn-username"),
        credential: readMeta("droply-turn-credential"),
      });
    }
  }

  return servers;
}

export const config = Object.freeze({
  appName: "Droply",
  signalingBaseUrl: resolveSignalingBaseUrl(),
  iceServers: resolveIceServers(),
  /** Default DataChannel chunk size. 32 KiB is safe on every browser/OS. */
  chunkSize: 32 * 1024,
  /** Stop reading new chunks while this many bytes are queued in the channel. */
  highWaterMark: 1024 * 1024,
  /** Resume sending once the channel buffer drops below this. */
  lowWaterMark: 256 * 1024,
  /** Abort a stalled transfer if no byte moves for this long. */
  stallTimeoutMs: 60_000,
  /** How long we wait for the data channel after both peers are in the room. */
  connectTimeoutMs: 45_000,
  /** Waiting-room lifetime; the server enforces its own TTL too. */
  roomTtlMs: 10 * 60_000,
  /** Copy shown in the UI about connection limits. */
  maxFiles: 200,
  maxFileBytes: 2 * 1024 ** 3,
  maxTotalBytes: 8 * 1024 ** 3,
});

/** Absolute URL of an API path on the signaling server. */
export function signalingUrl(pathname) {
  return `${config.signalingBaseUrl}${pathname}`;
}

/** WebSocket URL for a room socket. */
export function signalingSocketUrl(code, token) {
  const base = config.signalingBaseUrl || window.location.origin;
  const ws = base.replace(/^http/, "ws");
  return `${ws}/api/rooms/${encodeURIComponent(code)}/socket?token=${encodeURIComponent(token)}`;
}

/** Public receive link encoded in the QR code. */
export function receiveLink(code) {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/receive?code=${encodeURIComponent(code)}`;
}

/** True when running from a secure context (camera + WebRTC friendly). */
export function isSecureContext() {
  return window.isSecureContext || isLocalHost();
}
