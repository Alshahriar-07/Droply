# Error handling in Droply

Every failure Droply can produce is described **once**, in
[`js/core/errors.js`](../js/core/errors.js). Views never write their own failure copy: they pass a
catalog id (optionally with a short, non-sensitive `detail`) and render what comes back. That keeps
the full-page error, the inline error beside the code input and the toast word-for-word consistent.

Each catalog entry carries:

| Field | Meaning |
|---|---|
| `ref` | Stable reference such as `DL-RTC-02`, shown to the user and safe to quote in an issue |
| `title` | Short headline ("The devices couldn't connect") |
| `message` | What actually happened, in plain language |
| `recovery` | Ordered, concrete next steps |
| `icon` | Lucide glyph from the vendored icon table |
| `scope` | `page`, `inline` or `toast` |
| `retryable` | Whether another attempt could plausibly succeed |
| `actions` | Semantic action ids, resolved to buttons only when a handler exists |

## Surfaces

| Surface | Implementation | Used for |
|---|---|---|
| Full page | `mountErrorPage()` in `js/ui/error-view.js`, route `error` | Session-level failures: the transfer cannot continue |
| Inline | `inlineErrorMarkup()` / `showError()` on the code and file screens | Recoverable input problems — the user stays on the same screen |
| Toast | `errorToast()` → `#toast-stack` (`role="status"`) | Failures that also navigate away, such as cancellation |

`buildErrorActions()` in `js/app.js` maps action ids to real handlers. An action whose handler is
missing (no role, no code, no files) is dropped, so a "Retry" button can never be a no-op.

## Error inventory

`Retry` means the catalog marks the failure as plausibly recoverable by trying again; it does not
promise the retry will succeed.

| ID | Ref | Surface | When it appears | Retry |
|---|---|---|---|---|
| `network/offline` | DL-NET-01 | page | The browser fires `offline` during a session, or a request fails while the browser reports no connection | yes |
| `signaling/unreachable` | DL-SIG-01 | page | Room creation/join request never completes; room socket is not ready within 15 s; unknown service error code | yes |
| `signaling/lost` | DL-SIG-02 | page | The room socket closed and automatic reconnection did not restore it (~6.5 s) | yes |
| `signaling/rate-limited` | DL-SIG-03 | page | The Worker answers `429 rate_limited` for room creation or joins | yes |
| `signaling/rejected` | DL-SIG-04 | page | Origin rejected, malformed payload, unexpected response, or an `invalid_offer` / `invalid_answer` / `invalid_candidate` / `unknown_type` frame on the room socket | no |
| `room/not-found` | DL-ROOM-01 | inline | `POST /join` returns 404: no room has that code (typo, sender closed it, or it already completed) | no |
| `room/expired` | DL-ROOM-02 | inline | `POST /join` returns 410, or the room announces `room_closed: expired` after the TTL | no |
| `room/occupied` | DL-ROOM-03 | inline | `POST /join` returns 409: the single receiver slot is already taken | no |
| `room/closed` | DL-ROOM-04 | inline | `room_closed` with any reason other than completed/expired/cancelled/rejected/peer-left | no |
| `code/invalid` | DL-CODE-01 | inline | The typed value has the wrong length or the wrong alphabet (`O`, `0`, `I`, `1` are never issued) | no |
| `code/incomplete` | DL-CODE-02 | inline | Submit pressed with fewer than six characters | no |
| `peer/sender-left` | DL-PEER-02 | page | Receiver: the sender's socket closed (`room_closed: sender-left`) | yes |
| `peer/receiver-left` | DL-PEER-03 | page | Sender: `peer_left` for the receiver and it did not return within 8 s | yes |
| `peer/rejected` | DL-PEER-04 | page | Receiver pressed **Reject** (`receiver_reject` frame or in-band `reject` control) | yes |
| `connection/failed` | DL-RTC-01 | page | `RTCPeerConnection.connectionState === "failed"` after one automatic renegotiation, or an SDP offer/answer that fails validation | yes |
| `connection/relay-needed` | DL-RTC-02 | page | The same failure, but this deployment has no TURN relay configured — reported as such instead of blaming "the internet" | yes |
| `connection/timeout` | DL-RTC-03 | page | The data channel is not open within 45 s (sender) / 65 s (receiver) | yes |
| `connection/interrupted` | DL-RTC-04 | page | The data channel closed while the transfer was in flight | yes |
| `transfer/interrupted` | DL-XFER-01 | page | The transfer stopped without a cancel frame — e.g. the receiver tab was closed | yes |
| `transfer/failed` | DL-XFER-02 | page | Sender/receiver engine error: file read failure, malformed frame, protocol violation | yes |
| `transfer/cancelled` | DL-XFER-03 | toast | Either side pressed Cancel; the room is closed and the user returns home | no |
| `transfer/unconfirmed` | DL-XFER-05 | page | Every byte left the sender but no `confirmed` frame arrived within 10 s | yes |
| `transfer/integrity` | DL-XFER-04 | page | The receiver's byte count does not match the manifest, so completion is refused | yes |
| `file/read-denied` | DL-FILE-01 | inline | `File.slice()`/`arrayBuffer()` rejects — the file moved, was deleted or is locked | no |
| `file/too-large` | DL-FILE-02 | inline | A file exceeds 2 GB, or the selection exceeds the 8 GB per-transfer limit | no |
| `file/none-selected` | DL-FILE-03 | inline | "Create transfer" with an empty selection (also guarded by the disabled button) | no |
| `download/failed` | DL-FILE-04 | inline | Saving a received file threw — the blob URL expired or the browser refused the download | yes |
| `camera/denied` | DL-QR-01 | inline | `getUserMedia` rejects with `NotAllowedError`/`SecurityError` | yes |
| `camera/unavailable` | DL-QR-02 | inline | `NotFoundError`/`NotReadableError`/`OverconstrainedError` — no camera, or another app holds it | yes |
| `qr/invalid` | DL-QR-03 | inline | A QR code was decoded but contains no Droply code | yes |
| `qr/unavailable` | DL-QR-04 | inline | The decoder is unavailable, or the page is not a secure context | no |
| `browser/unsupported` | DL-ENV-01 | page | `RTCPeerConnection` or `RTCDataChannel` is missing | no |
| `browser/insecure` | DL-ENV-02 | page | The page is served over plain HTTP (not localhost) | no |
| `app/unexpected` | DL-APP-01 | page | Uncaught exception or unhandled rejection during a session, with a diagnostic id | yes |

## Recovery actions

| Action id | Button | Handler |
|---|---|---|
| `retry` | Try again / Reconnect | Re-runs room creation with the same files (sender) or rejoins the same code (receiver); only rendered when one of those is possible |
| `reconnect` | Reconnect | Re-opens the socket for the current code |
| `enter-code` | Enter another code | Opens the code screen, prefilled |
| `scan` | Scan a QR code | Opens the scanner |
| `camera-permission` | Retry camera access | Re-opens the scanner (the browser may prompt again) |
| `choose-files` | Choose files | Returns to file selection with the previous list |
| `start-transfer` | Start a new transfer | New room with the same files, or the file picker when none are held |
| `retry-download` | Save again | Inline on the completion screen; retries the same blob download |
| `reload` | Reload page | Full reload (used where a re-render cannot fix the state) |
| `home` | Back home | Clears the session and returns to the start screen |

## Branded HTTP error pages

`error.html` is a self-contained document (design tokens + `base.css`, no app bundle) used by hosts
that cannot render the SPA for a 4xx/5xx.

| Route | Status | Copy |
|---|---|---|
| `/403` | 403 | You can't open this |
| `/404` | 404 | There's nothing here (also `404.html`, served by Vercel automatically) |
| `/410` | 410 | That transfer has expired |
| `/429` | 429 | Slow down a moment |
| `/500` | 500 | Droply hit an internal error |
| `/502` | 502 | The connection service didn't answer |
| `/503` | 503 | Droply is temporarily unavailable |
| `/504` | 504 | The request took too long |

Routing lives in `vercel.json` and points each path at `api/error.js`, an Edge Function that returns
the page **with the requested status code** (static rewrites alone would answer `200`). The page
derives its copy from its own path (`/403`), so it still renders correctly if a proxy strips the
query string. Every error surface is `noindex, nofollow` — via `<meta>`, `X-Robots-Tag` and
`robots.txt`.

Error pages are never listed in `sitemap.xml`.

## Diagnostics and privacy

- An unexpected exception gets a diagnostic id such as `DL-4H7K2M` from `createDiagnosticId()`.
  It is random, carries no room code, token or file name, and is safe to paste into an issue.
- The id is logged to the console with the exception (local only); nothing is sent anywhere.
- Stack traces, raw `error.message` text from the network and internal URLs are never rendered —
  `safeDetail()` truncates to a single 160-character line, and catalog copy is what the user reads.
- `File` objects, chunk buffers and room tokens never enter an error message.

## Accuracy rules the implementation follows

- **Receiver not found vs. expired session.** "Not found" is a 404 from the Worker; "expired" is a
  410, or a `room_closed: expired` frame. They are separate ids with different recovery steps.
- **Offline means evidence.** `navigator.onLine` is only consulted *after* a request or socket has
  already failed, or on the browser's own `offline` event. A slow server is never reported as
  "you're offline".
- **No false completion.** A partial transfer always produces a failure state; the completion screen
  is only reachable after the receiver has verified every byte.
- **No resumable transfers are promised.** Recovery copy says to run a new transfer.
- **TURN is only mentioned when its absence is a fact** — `hasRelayConfigured()` reads the configured
  ICE server list.
- **One-time rooms leave no state.** A completed room is deleted immediately (privacy by design), so
  reusing its code reports `room/not-found`, not a separate "already used" error. The copy names both
  possible causes instead of guessing.

## Verification

| Check | Status |
|---|---|
| Catalog integrity (unique refs, complete copy, bundled icons, known actions) | automated — `npm test` |
| Signaling code → catalog mapping, unknown-code fallback | automated — `npm test` |
| Diagnostic id format and randomness | automated — `npm test` |
| Full-page error renders ref, steps, actions, diagnostic, collapsed details | verified in headless Chrome at 360–1920 px |
| Focus moves to the error headline; no focus ring on a non-interactive heading | verified in headless Chrome |
| Inline code error announces through `role="alert"` and refocuses the input | verified in headless Chrome |
| `error.html` / `404.html` copy, `noindex`, mobile layout | verified in headless Chrome |
| Real network loss, Worker 429/500, ICE failure, receiver rejection | **not exercised in a browser** — these need a worker with fault injection or two real devices |
| `api/error.js` on a real Vercel deployment | **not verified** — requires deploying |

## Adding a new error

1. Add an entry to `ERROR_CATALOG` with a fresh `ref`, honest copy and recovery steps.
2. If a Worker/protocol code produces it, map that code in `SIGNALING_ERROR_MAP` (or handle it in
   `app.js` where the event arrives).
3. If it needs a new button, add the id to `ERROR_ACTION`, implement the handler in
   `buildErrorActions()` and document it above. Never add an action without a handler.
4. Run `npm test` — the suite fails if copy is missing, an icon is not bundled, or an action id is
   unknown.
