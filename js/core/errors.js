/**
 * Central error catalog.
 *
 * Every failure Droply can hit is described once, here:
 *
 *   ref        short reference shown to the user (and used in bug reports)
 *   title      human headline
 *   message    what actually happened, in plain language
 *   recovery   concrete steps the user can take
 *   actions    semantic action ids; the view only renders those it can wire
 *              up to a working handler, so no dead "Retry" buttons
 *   scope      "page" (full screen), "inline" (inside a card), "toast"
 *   retryable  whether another attempt could plausibly succeed
 *
 * Views must not invent copy for failures: they pass an id from this catalog
 * (optionally with a safe `detail`) and render what comes back.
 */

/** @typedef {"page"|"inline"|"toast"} ErrorScope */

export const ERROR_SCOPE = Object.freeze({
  PAGE: "page",
  INLINE: "inline",
  TOAST: "toast",
});

/**
 * Action ids understood by the UI layer. A missing handler means the action is
 * simply not offered — never rendered as a dead button.
 */
export const ERROR_ACTION = Object.freeze({
  RETRY: "retry",
  RECONNECT: "reconnect",
  ENTER_CODE: "enter-code",
  SCAN: "scan",
  CHOOSE_FILES: "choose-files",
  START_TRANSFER: "start-transfer",
  HOME: "home",
  RELOAD: "reload",
  CAMERA: "camera-permission",
  RETRY_DOWNLOAD: "retry-download",
});

const entry = (spec) => Object.freeze({ scope: ERROR_SCOPE.PAGE, retryable: false, ...spec });

export const ERROR_CATALOG = Object.freeze({
  /* ---------------------------------------------------------------- network */
  "network/offline": entry({
    ref: "DL-NET-01",
    title: "You're offline",
    message:
      "Droply lost the network connection while the transfer was running. Files already received are still in this tab.",
    recovery: [
      "Reconnect to Wi-Fi or mobile data.",
      "Keep this tab open — the transfer resumes only if the other device is still waiting.",
    ],
    icon: "wifi-off",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "signaling/unreachable": entry({
    ref: "DL-SIG-01",
    title: "Can't reach the connection service",
    message:
      "The room service that pairs the two devices did not respond. Without it the devices can't find each other.",
    recovery: [
      "Check your internet connection and try again.",
      "If this is your own deployment, confirm the signaling Worker is running and the URL in the page metadata is correct.",
    ],
    icon: "server-off",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "signaling/lost": entry({
    ref: "DL-SIG-02",
    title: "Room connection lost",
    message: "Droply lost the connection to the transfer room and could not re-establish it.",
    recovery: [
      "Check your connection, then start a new transfer.",
      "The other device has to stay on the same room for the connection to come back.",
    ],
    icon: "unplug",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "signaling/rate-limited": entry({
    ref: "DL-SIG-03",
    title: "Too many attempts",
    message: "Droply is receiving too many requests from this network, so it is pausing briefly.",
    recovery: ["Wait about a minute, then try again."],
    icon: "clock-alert",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "signaling/rejected": entry({
    ref: "DL-SIG-04",
    title: "The connection service refused the request",
    message:
      "The room service rejected this request. This usually means the site is not on its allowed-origins list, or the request did not match what the service accepts.",
    recovery: [
      "Reload the page and try once more.",
      "If you host Droply yourself, check ALLOWED_ORIGINS on the signaling Worker.",
    ],
    icon: "server-off",
    actions: [ERROR_ACTION.RELOAD, ERROR_ACTION.HOME],
    retryable: false,
  }),

  // A 5xx, or a response that isn't the JSON the client expects. Distinct from
  // the rejection above: the service is broken rather than refusing this site,
  // and the same request can succeed on a retry.
  "signaling/error": entry({
    ref: "DL-SIG-05",
    title: "The connection service is having trouble",
    message:
      "The room service returned an error instead of pairing the devices. This is usually a short outage on the service, not a problem with your files.",
    recovery: [
      "Wait a moment, then try again.",
      "If you host Droply yourself, check the signaling Worker logs for the failing request.",
    ],
    icon: "server-crash",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  /* ------------------------------------------------------------------- room */
  "room/not-found": entry({
    ref: "DL-ROOM-01",
    title: "That transfer code wasn't found",
    message:
      "No open room matches this code. It may have been mistyped, or the sender may have closed the transfer.",
    recovery: [
      "Check all six characters with the sender.",
      "Ask the sender to keep their tab open and create a fresh code.",
    ],
    icon: "search-x",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.ENTER_CODE, ERROR_ACTION.SCAN],
    retryable: false,
  }),

  "room/expired": entry({
    ref: "DL-ROOM-02",
    title: "This transfer expired",
    message:
      "Transfer rooms are one-time and expire after ten minutes of waiting, or as soon as they are used.",
    recovery: ["Ask the sender to create a new transfer code."],
    icon: "clock-alert",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.ENTER_CODE, ERROR_ACTION.HOME],
    retryable: false,
  }),

  "room/occupied": entry({
    ref: "DL-ROOM-03",
    title: "This transfer already has a receiver",
    message: "A room accepts exactly one sender and one receiver. Another device is already paired.",
    recovery: [
      "If you are the intended receiver, ask the sender for a new transfer.",
      "If you did not expect this, treat the code as shared too widely and start over.",
    ],
    icon: "ban",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.ENTER_CODE, ERROR_ACTION.HOME],
    retryable: false,
  }),

  "room/closed": entry({
    ref: "DL-ROOM-04",
    title: "This transfer has ended",
    message: "The sender closed the room, or it was already used for a completed transfer.",
    recovery: ["Start your own transfer, or ask the sender for a new code."],
    icon: "ban",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.ENTER_CODE, ERROR_ACTION.HOME],
    retryable: false,
  }),

  "code/invalid": entry({
    ref: "DL-CODE-01",
    title: "That code isn't valid",
    message: "A Droply transfer code is exactly six characters. Letters like O, I and 0, 1 are not used.",
    recovery: ["Retype the six characters shown on the sending device."],
    icon: "keyboard",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.ENTER_CODE, ERROR_ACTION.SCAN],
    retryable: false,
  }),

  "code/incomplete": entry({
    ref: "DL-CODE-02",
    title: "Enter all six characters",
    message: "A Droply code is six characters long. The form will unlock when all six are filled in.",
    recovery: ["Copy the whole code from the sending device and paste it here."],
    icon: "keyboard",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.ENTER_CODE],
    retryable: false,
  }),

  /* ------------------------------------------------------------------ peers */
  "peer/sender-left": entry({
    ref: "DL-PEER-02",
    title: "The sending device disconnected",
    message: "The sender closed the tab or lost their connection, so the room was closed.",
    recovery: ["Ask the sender to open Droply again and create a new transfer."],
    icon: "unplug",
    actions: [ERROR_ACTION.ENTER_CODE, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "peer/receiver-left": entry({
    ref: "DL-PEER-03",
    title: "The receiving device disconnected",
    message: "The receiver left before the transfer finished. Files already sent were not confirmed.",
    recovery: ["Create a new transfer and share the new code."],
    icon: "unplug",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "peer/rejected": entry({
    ref: "DL-PEER-04",
    title: "The receiver declined",
    message: "The receiving device rejected this transfer. No file data was sent.",
    recovery: ["Confirm with the receiver, then create a new transfer if they change their mind."],
    icon: "ban",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  /* -------------------------------------------------------------- WebRTC */
  "connection/failed": entry({
    ref: "DL-RTC-01",
    title: "The devices couldn't connect",
    message:
      "The browsers could not establish a direct network route. This is common on strict corporate networks, VPNs and some mobile carriers.",
    recovery: [
      "Try again from a different network, for example a phone hotspot.",
      "Reload both tabs and start a fresh transfer.",
    ],
    icon: "triangle-alert",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "connection/relay-needed": entry({
    ref: "DL-RTC-02",
    title: "This network needs a relay",
    message:
      "Both devices are behind NAT configurations that block a direct route, and no TURN relay is configured for this deployment. Nothing was transferred.",
    recovery: [
      "Try a different network on either device — a mobile hotspot usually works.",
      "If you host Droply, configure the optional TURN settings to support these networks.",
    ],
    icon: "unplug",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "connection/timeout": entry({
    ref: "DL-RTC-03",
    title: "The connection timed out",
    message: "The other device did not answer in time, so Droply stopped waiting.",
    recovery: [
      "Make sure the other device is awake with Droply in the foreground.",
      "Check both devices have a working connection, then try again.",
    ],
    icon: "clock-alert",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "connection/interrupted": entry({
    ref: "DL-RTC-04",
    title: "The connection dropped",
    message:
      "The direct connection between the devices closed before the transfer finished. A partial transfer is never reported as complete.",
    recovery: [
      "Start a new transfer to get the remaining files.",
      "Keep both tabs open and in the foreground until a transfer ends.",
    ],
    icon: "unplug",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  /* -------------------------------------------------------------- transfer */
  "transfer/interrupted": entry({
    ref: "DL-XFER-01",
    title: "Transfer interrupted",
    message:
      "The transfer stopped before every byte arrived. Droply never marks a partial transfer as complete.",
    recovery: [
      "Run the transfer again to get the rest.",
      "Files are only offered for saving once a transfer completes in full.",
    ],
    icon: "triangle-alert",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "transfer/failed": entry({
    ref: "DL-XFER-02",
    title: "The transfer failed",
    message: "The transfer stopped because of an error while moving file data.",
    recovery: [
      "Start a new transfer for the same files.",
      "If it keeps failing on one file, that file may be locked by another app or unreadable.",
    ],
    icon: "file-x",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  // Reached from failTransfer() on the side that did *not* press Cancel, so it
  // is a terminal session state for that tab, not a passing notice. The side
  // that cancels gets a toast from cancelTransfer() instead.
  "transfer/cancelled": entry({
    ref: "DL-XFER-03",
    title: "Transfer cancelled",
    message: "This transfer was cancelled. No more file data will be sent or accepted.",
    recovery: ["Create a new transfer when you're ready."],
    icon: "ban",
    actions: [ERROR_ACTION.START_TRANSFER, ERROR_ACTION.HOME],
    retryable: false,
  }),

  "transfer/unconfirmed": entry({
    ref: "DL-XFER-05",
    title: "Delivery wasn't confirmed",
    message:
      "Every byte left this device, but the receiving browser never confirmed that it assembled the files.",
    recovery: [
      "Open the receiving device and check whether the files arrived.",
      "If they are missing or incomplete, run the transfer again.",
    ],
    icon: "clock-alert",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  "transfer/integrity": entry({
    ref: "DL-XFER-04",
    title: "Files didn't arrive intact",
    message:
      "The received byte count did not match what the sender announced, so Droply did not mark the transfer complete.",
    recovery: ["Start a new transfer for the affected files."],
    icon: "shield-alert",
    actions: [ERROR_ACTION.RETRY, ERROR_ACTION.HOME],
    retryable: true,
  }),

  /* ------------------------------------------------------------------ files */
  "file/read-denied": entry({
    ref: "DL-FILE-01",
    title: "Droply can't read that file",
    message:
      "The browser refused to read a selected file. This happens when the file moved, was deleted, or is locked by another app.",
    recovery: ["Re-select the file, or copy it to a local folder and try again."],
    icon: "file-x",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.CHOOSE_FILES, ERROR_ACTION.HOME],
    retryable: false,
  }),

  "file/too-large": entry({
    ref: "DL-FILE-02",
    title: "That file is too large",
    message:
      "Droply's configured limit is 5 GB per file and 5 GB for the whole transfer. Both devices need enough memory and disk space for what they send and receive.",
    recovery: ["Split the file, or send fewer files in one transfer."],
    icon: "file-x",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.CHOOSE_FILES],
    retryable: false,
  }),

  "file/none-selected": entry({
    ref: "DL-FILE-03",
    title: "Add at least one file",
    message: "A transfer needs one or more files before it can create a room.",
    recovery: ["Drop files onto the panel, or use the file picker."],
    icon: "folder-open",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.CHOOSE_FILES],
    retryable: false,
  }),

  "download/failed": entry({
    ref: "DL-FILE-04",
    title: "The download didn't start",
    message: "The browser did not accept the file download. The data is still in this tab.",
    recovery: [
      "Allow downloads for this site, then press Save again.",
      "On mobile, check that the browser can write to storage.",
    ],
    icon: "hard-drive-download",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.RETRY_DOWNLOAD],
    retryable: true,
  }),

  /* ----------------------------------------------------------------- camera */
  "camera/denied": entry({
    ref: "DL-QR-01",
    title: "Camera permission denied",
    message: "Droply only uses the camera to read a QR code, and only after you ask it to.",
    recovery: [
      "Allow camera access for this site in your browser settings, then try again.",
      "You can always type the six-character code instead.",
    ],
    icon: "camera-off",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.CAMERA, ERROR_ACTION.ENTER_CODE],
    retryable: true,
  }),

  "camera/unavailable": entry({
    ref: "DL-QR-02",
    title: "No camera available",
    message: "This device has no usable camera, or another app is holding it.",
    recovery: ["Close other apps that use the camera, or type the code instead."],
    icon: "camera-off",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.CAMERA, ERROR_ACTION.ENTER_CODE],
    retryable: true,
  }),

  "qr/invalid": entry({
    ref: "DL-QR-03",
    title: "That isn't a Droply code",
    message: "The QR code was read, but it does not contain a Droply transfer code.",
    recovery: ["Scan the QR shown on the sending device, or type the code manually."],
    icon: "qr-code",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.SCAN, ERROR_ACTION.ENTER_CODE],
    retryable: true,
  }),

  "qr/unavailable": entry({
    ref: "DL-QR-04",
    title: "Scanner unavailable",
    message: "This browser can't decode QR codes from the camera. Typing the code works just as well.",
    recovery: ["Enter the six-character code on the receiving screen."],
    icon: "scan-line",
    scope: ERROR_SCOPE.INLINE,
    actions: [ERROR_ACTION.ENTER_CODE],
    retryable: false,
  }),

  /* -------------------------------------------------------------- environment */
  "browser/unsupported": entry({
    ref: "DL-ENV-01",
    title: "This browser can't run Droply",
    message:
      "Droply needs WebRTC data channels to move files directly between devices. This browser doesn't expose them.",
    recovery: ["Use a current version of Chrome, Edge, Firefox or Safari on desktop or mobile."],
    icon: "triangle-alert",
    actions: [ERROR_ACTION.RELOAD],
    retryable: false,
  }),

  "browser/insecure": entry({
    ref: "DL-ENV-02",
    title: "A secure connection is required",
    message:
      "WebRTC and camera access only work over HTTPS (or on localhost). This page was opened over plain HTTP.",
    recovery: ["Open Droply from its https:// address and try again."],
    icon: "lock",
    actions: [ERROR_ACTION.RELOAD],
    retryable: false,
  }),

  /* ---------------------------------------------------------------- unexpected */
  "app/unexpected": entry({
    ref: "DL-APP-01",
    title: "Something went wrong",
    message:
      "Droply hit an unexpected error. No file contents are logged or sent anywhere — the details below are safe to share.",
    recovery: [
      "Reload the page and try again.",
      "If it happens again, report the reference below on GitHub.",
    ],
    icon: "circle-alert",
    actions: [ERROR_ACTION.RELOAD, ERROR_ACTION.HOME],
    retryable: true,
  }),
});

/** Fallback when an unknown id is passed (never throws in a UI path). */
export const DEFAULT_ERROR_ID = "app/unexpected";

/**
 * Signaling service error codes → catalog ids. Keeping this in one table means
 * the UI never has to guess what the Worker meant.
 */
export const SIGNALING_ERROR_MAP = Object.freeze({
  room_not_found: "room/not-found",
  room_expired: "room/expired",
  room_occupied: "room/occupied",
  room_closed: "room/closed",
  invalid_code: "code/invalid",
  rate_limited: "signaling/rate-limited",
  origin_rejected: "signaling/rejected",
  bad_request: "signaling/rejected",
  server_error: "signaling/error",
  network_error: "signaling/unreachable",
  invalid_response: "signaling/error",
  unsupported_media_type: "signaling/rejected",
  payload_too_large: "signaling/rejected",
  method_not_allowed: "signaling/rejected",
  upgrade_required: "signaling/rejected",
  unauthorized: "signaling/rejected",
  not_found: "signaling/rejected",
  conflict: "room/occupied",
  signaling_error: "signaling/unreachable",
  // Protocol-level rejections from the room socket: the peer sent something
  // the signaling service could not use. Not a network outage.
  invalid_message: "signaling/rejected",
  invalid_offer: "signaling/rejected",
  invalid_answer: "signaling/rejected",
  invalid_candidate: "signaling/rejected",
  unknown_type: "signaling/rejected",
});

/** Codes that mean "this code is not usable" and belong inline on the input. */
export const CODE_ERROR_IDS = Object.freeze([
  "room/not-found",
  "room/expired",
  "room/occupied",
  "room/closed",
  "code/invalid",
  "code/incomplete",
]);

/**
 * @param {string|null|undefined} code Raw signaling error code.
 * @returns {string} Catalog id.
 */
export function errorIdForSignalingCode(code) {
  if (!code) return "signaling/unreachable";
  return SIGNALING_ERROR_MAP[code] ?? "signaling/unreachable";
}

/** True when the failure should be shown next to the code input. */
export function isCodeError(id) {
  return CODE_ERROR_IDS.includes(id);
}

/**
 * @param {string} id
 * @returns {typeof ERROR_CATALOG[keyof typeof ERROR_CATALOG]}
 */
export function getErrorSpec(id) {
  return ERROR_CATALOG[id] ?? ERROR_CATALOG[DEFAULT_ERROR_ID];
}

/* --------------------------------------------------------------------------
   Diagnostics
   -------------------------------------------------------------------------- */

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A short, non-secret reference the user can quote in a bug report. It carries
 * no room code, token or file name.
 */
export function createDiagnosticId(prefix = "DL") {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += REF_ALPHABET[byte % REF_ALPHABET.length];
  return `${prefix}-${out}`;
}

/**
 * Normalises a catalog entry for display.
 *
 * @param {string} id Catalog id.
 * @param {{ detail?: string, actions?: string[] }} [options]
 */
export function describeError(id, options = {}) {
  const spec = getErrorSpec(id);
  const resolvedId = ERROR_CATALOG[id] ? id : DEFAULT_ERROR_ID;
  return {
    id: resolvedId,
    ref: spec.ref,
    title: spec.title,
    message: spec.message,
    recovery: spec.recovery,
    icon: spec.icon,
    scope: spec.scope,
    retryable: spec.retryable,
    actions: options.actions ?? spec.actions ?? [],
    detail: options.detail ?? "",
  };
}

/** Public list used by the docs and the test suite. */
export function listErrorIds() {
  return Object.keys(ERROR_CATALOG);
}
