# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through
[GitHub Security Advisories](https://github.com/Alshahriar-07/Droply/security/advisories/new) or by
email to the maintainer listed on [alshahriarsayon.vercel.app](https://alshahriarsayon.vercel.app/).

Include what you did, what you observed, and the browser/OS you used. You can expect an
acknowledgement within a few days. Please give us a reasonable window to ship a fix before disclosing.

## Design

Droply has two independent parts with very different trust assumptions.

**The signaling service** (Cloudflare Worker + Durable Objects) is the only server component. It is
treated as untrusted-but-visible: it routes messages, it should never be able to read a file.

**The browsers** hold all file data. Two peers talk over a WebRTC `RTCDataChannel` secured by DTLS,
which is end-to-end between the two devices.

### What the server receives and stores

| Data | Stored in the Durable Object | Lifetime |
|---|---|---|
| Room code, role (`sender`/`receiver`) | yes | room TTL (10 min default) |
| Short-lived bearer tokens (hashed comparison) | yes | room TTL |
| SDP offer / answer, ICE candidates | relayed, not persisted | request lifetime |
| File names, sizes, contents | **never** | — |

Encryption keys for the data channel are negotiated by DTLS between the peers; the signaling service
only forwards ciphertext-free SDP/ICE. File bytes never enter the Worker — the frontend has no code
path that uploads file data, and adding one would be a defect.

### Room access control

- A six-character code is **not** treated as a secret on its own. Creating a room returns a random
  token bound to the sender; joining returns a token bound to the receiver.
- Every WebSocket upgrade must present a valid token for that room.
- A room accepts at most one sender and one receiver. Later participants are rejected with `410`.
- A room closes on completion, cancellation, rejection, or TTL expiry, and the Durable Object deletes
  its state.

### Abuse resistance

- Origin allow-listing (`ALLOWED_ORIGINS`) on every API request and WebSocket upgrade.
- Token-bucket rate limiting per client IP for room creation, joins and socket upgrades, backed by a
  Durable Object.
- Payload validation: methods, content type, JSON shape and size limits; unknown message kinds and
  oversized frames are rejected.
- Room creation is capped, so anonymous clients cannot exhaust the object namespace.

## Privacy

- No accounts, sign-in, cookies, or analytics.
- No transfer history is written anywhere, on either side.
- No file contents are uploaded, logged, or cached by the server.
- The frontend keeps everything in memory for the lifetime of the tab, and disposing a transfer
  revokes object URLs, closes the socket, closes the peer connection and stops camera tracks.
- The room code lives in the URL fragment (`#/receive?code=...`) so it is not sent in HTTP requests or
  referrers.

## Known limitations

- **TURN is optional and off by default.** On symmetric NAT, a relay is required. When TURN is
  configured, the relay forwards encrypted WebRTC packets — it cannot read them, but it does see
  connection metadata (IPs, byte volume).
- **Six-character codes are short.** Rate limiting, single-use rooms and per-room tokens mitigate
  guessing, but a code should be shared privately. Do not post codes publicly.
- **No Content-Security-Policy is shipped yet.** The app uses inline JSON-LD metadata and vendored
  scripts; a tested CSP (including the camera permission policy) is planned. `vercel.json` does set
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy`.
- **Vendored libraries** (`qrcode-generator`, `jsQR`) are committed rather than loaded from a CDN so
  the app works offline and cannot be hijacked by a supply-chain change. Their licences are in
  `js/vendor/`.
- **The receiver holds received files in memory** until saved. This is a browser constraint, not a
  server exposure, but a very large transfer needs matching RAM.
