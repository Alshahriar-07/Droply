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
which is end-to-end between the two devices. Device identity (for Saved Devices) is generated with
WebCrypto and never leaves the browser: only public keys are shared, and private keys are stored as
non-extractable `CryptoKey` handles in IndexedDB.

### What the server receives and stores

| Data | Stored in the Durable Object | Lifetime |
|---|---|---|
| Room code, role (`sender`/`receiver`) | yes | room TTL (10 min default) |
| Short-lived bearer tokens (hashed comparison) | yes | room TTL |
| SDP offer / answer, ICE candidates | relayed, not persisted | request lifetime |
| Nearby presence (display name, device type, pseudonymous ids, availability) | yes, only while the user opted in | 2 min without a heartbeat, deleted immediately when the socket closes |
| Signed transfer invites (one-time room code + signature) | relayed, not persisted | request lifetime |
| Saved-device public keys and any private key | **never** — browser storage only | — |
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

### Nearby presence and saved devices

- Presence is opt-in per session. Nothing is registered until the user presses **Start discovery**
  (or enables reachability on the Saved Devices screen), and **Stop** unregisters immediately.
- Presence groups are keyed by a salted hash of the client's public network address, computed and
  consumed inside the Worker. Neither the address nor its group key is returned to a client, so
  "same network" works without exposing an IP.
- A group holds at most 25 records. Each record is deleted when its socket closes, on an explicit
  `leave`, or two minutes after the last heartbeat, whichever comes first. There is no history.
- Only a random 128-bit peer id, a pseudonymous device id (a hash of the device's public key), a
  display name, a coarse platform label and an availability flag are broadcast.
- Invite payloads are validated (shape, size, room-code alphabet) and relayed without being stored.
  The server cannot forge one, because the signature is verified in the receiving browser against a
  saved public key.
- An invite for a saved device that fails signature verification is declined and never shown as that
  device. Unknown devices are clearly labelled as unsaved and still require an explicit choice.
- Removed devices lose their stored public key, so they can no longer produce a verified invite.

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
- **Nearby discovery is not link-local discovery.** It reflects the public address the Worker sees,
  so devices behind the same NAT meet, while a VPN, guest network or carrier-grade NAT can hide a
  device that is physically nearby. It also tells the server that *some* devices opted in behind that
  address — which the operator can already infer from connection metadata.
- **Saved-device identity is browser-profile scoped.** Clearing site data deletes the private keys,
  so the device must be paired again; another browser profile is a different device.
- **Invites are short-lived and single-use.** An invite older than ten minutes is rejected, and its
  room code expires on the usual room TTL, so a replayed invite cannot start a transfer much later.
- **Pairing codes are five-minute, single-use rendezvous values.** A code lets two browsers exchange
  public keys exactly once; it authorises nothing afterwards and is never sent to the other device
  as a credential. The owner token that can read, rotate or close its own session is stored only as
  a SHA-256 hash, rotates with every regeneration and is destroyed with the session. Reconnection
  later uses the saved device's ECDSA key and signed invites, never this code.
