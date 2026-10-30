/**
 * Droply application controller.
 *
 * Owns the session lifecycle: room creation/joining, signaling events, the
 * peer connection, the transfer engines and the screens that display them.
 * Every UI state change below is driven by a real browser/network event.
 */

import { config, isSecureContext, receiveLink } from "./config.js";
import { navigate, registerRoute } from "./router.js";
import { isActive, resetSession, session, setSession } from "./state.js";
import { bindInfoDialogs, el, escapeHtml, toast } from "./ui/common.js";
import { mountHome } from "./ui/home.js";
import { mountFileSelection, mountSenderWaiting } from "./ui/sender-view.js";
import {
  mountCodeEntry,
  mountIncomingTransfer,
  mountReceiveChoice,
} from "./ui/receiver-view.js";
import { mountQrScanner } from "./ui/qr-scanner.js";
import {
  mountTransfer,
  mountTransferComplete,
} from "./ui/transfer-view.js";
import { ConnectionAnimation } from "./ui/connection-animation.js";
import { SignalingClient } from "./core/signaling-client.js";
import { PeerConnection, isWebRtcSupported } from "./core/peer-connection.js";
import { DataChannelTransport } from "./core/data-channel.js";
import { FileSender } from "./core/file-sender.js";
import { FileReceiver } from "./core/file-receiver.js";
import { ResourceScope } from "./core/cleanup.js";
import {
  ERROR_ACTION,
  DEFAULT_ERROR_ID,
  createDiagnosticId,
  errorIdForSignalingCode,
  getErrorSpec,
  isCodeError,
} from "./core/errors.js";
import { errorToast, isPageError, mountErrorPage } from "./ui/error-view.js";
import { CONTROL } from "./core/transfer-protocol.js";
import { extractRoomCode, isProbablySdp } from "./utils/validation.js";
import { formatBytes } from "./utils/format-bytes.js";

/* --------------------------------------------------------------------------
   Runtime state (never persisted)
   -------------------------------------------------------------------------- */

const app = {
  /** @type {SignalingClient|null} */
  signaling: null,
  /** @type {PeerConnection|null} */
  peer: null,
  /** @type {DataChannelTransport|null} */
  transport: null,
  /** @type {FileSender|null} */
  sender: null,
  /** @type {FileReceiver|null} */
  receiver: null,
  /** @type {"sender"|"receiver"|null} */
  role: null,
  code: null,
  /** @type {File[]} */
  senderFiles: [],
  senderBytes: 0,
  /** @type {Array<{name:string,size:number,url?:string}>} */
  receivedFiles: [],
  receivedBytes: 0,
  /** @type {ConnectionAnimation|null} */
  animation: null,
  /** @type {{setError?:Function}|null} */
  selectionView: null,
  /** @type {{update:Function, setStatus:Function, setPath:Function, markComplete:Function}|null} */
  transferView: null,
  pendingAccept: false,
  deliveryConfirmed: false,
  transferStartedAt: 0,
  receivedElapsed: 0,
  retryAttempts: 0,
  failureShown: false,
  connectTimer: 0,
  readyTimer: 0,
  confirmTimer: 0,
  closeTimer: 0,
  graceTimer: 0,
  unloadHandler: null,
  scope: new ResourceScope(),
};

function go(name, params = {}) {
  navigate(name, params, { force: true });
}

function clearTimer(name) {
  if (app[name]) {
    window.clearTimeout(app[name]);
    app[name] = 0;
  }
}

function clearAllTimers() {
  for (const key of [
    "connectTimer",
    "readyTimer",
    "confirmTimer",
    "closeTimer",
    "graceTimer",
  ]) {
    clearTimer(key);
  }
}

function addUnloadGuard() {
  if (app.unloadHandler) return;
  app.unloadHandler = (event) => {
    if (!isActive()) return undefined;
    event.preventDefault();
    event.returnValue = "";
    return "";
  };
  window.addEventListener("beforeunload", app.unloadHandler);
}

function removeUnloadGuard() {
  if (!app.unloadHandler) return;
  window.removeEventListener("beforeunload", app.unloadHandler);
  app.unloadHandler = null;
}

/** Closes the media/transfer path, and optionally the signaling socket. */
function closeConnections({ keepReceiver = false, keepSignaling = false } = {}) {
  clearAllTimers();
  try {
    app.sender?.dispose();
  } catch {
    /* already disposed */
  }
  try {
    app.transport?.close();
  } catch {
    /* already closed */
  }
  try {
    app.peer?.close();
  } catch {
    /* already closed */
  }
  if (!keepSignaling) app.signaling?.close();
  if (!keepReceiver) app.receiver?.dispose();

  app.transport = null;
  app.peer = null;
  app.sender = null;
  if (!keepReceiver) app.receiver = null;
  if (!keepSignaling) app.signaling = null;
  removeUnloadGuard();
}

/** Full reset used when leaving a session (not on the completion screen). */
function resetRuntime({ keepReceiver = false } = {}) {
  closeConnections({ keepReceiver });
  app.role = null;
  app.code = null;
  app.pendingAccept = false;
  app.deliveryConfirmed = false;
  app.transferStartedAt = 0;
  app.retryAttempts = 0;
  app.failureShown = false;
  app.animation = null;
  app.transferView = null;
  app.selectionView = null;
  app.receivedFiles = [];
  app.receivedBytes = 0;
  app.receivedElapsed = 0;
  app.scope.dispose();
  app.scope = new ResourceScope();
}

function goHome() {
  resetRuntime();
  resetSession();
  go("home");
}

/* --------------------------------------------------------------------------
   Failure handling
   -------------------------------------------------------------------------- */

/**
 * A one-line, non-sensitive description of a browser/runtime error. Stack
 * traces, tokens and file contents never reach the UI.
 *
 * @param {unknown} error
 */
function safeDetail(error) {
  const raw = typeof error === "string" ? error : error?.message;
  if (!raw) return "";
  return String(raw).split("\n")[0].slice(0, 160);
}

/** True when there is concrete evidence the network is down, not just a hunch. */
function looksOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Turns semantic action ids into real, working buttons. Anything without a
 * usable handler is dropped, so a failure never offers a dead "Retry".
 *
 * @param {string[]} actionIds
 * @param {{ retryable?: boolean }} [options]
 */
function buildErrorActions(actionIds = [], options = {}) {
  const role = app.role;
  const files = [...app.senderFiles];
  const code = app.code;

  const retryHandler = (() => {
    if (options.retryable === false) return null;
    if (role === "sender" && files.length) return () => void createTransfer(files);
    if (role === "receiver" && code) return () => void joinRoom(code);
    return null;
  })();

  const handlers = {
    [ERROR_ACTION.RETRY]: retryHandler
      ? { label: role === "sender" ? "Try again" : "Reconnect", icon: "rotate-cw", onClick: retryHandler }
      : null,
    [ERROR_ACTION.RECONNECT]: code
      ? { label: "Reconnect", icon: "rotate-cw", onClick: () => void joinRoom(code) }
      : null,
    [ERROR_ACTION.ENTER_CODE]: {
      label: "Enter another code",
      variant: "secondary",
      icon: "keyboard",
      onClick: () => go("code", { initialCode: code ?? "" }),
    },
    [ERROR_ACTION.SCAN]: {
      label: "Scan a QR code",
      variant: "secondary",
      icon: "qr-code",
      onClick: () => go("scan"),
    },
    [ERROR_ACTION.CAMERA]: {
      label: "Retry camera access",
      icon: "camera",
      onClick: () => go("scan"),
    },
    [ERROR_ACTION.CHOOSE_FILES]: {
      label: "Choose files",
      icon: "folder-open",
      onClick: () => go("send", { files }),
    },
    [ERROR_ACTION.START_TRANSFER]: {
      label: "Start a new transfer",
      icon: "rotate-cw",
      onClick: () => (files.length ? void createTransfer(files) : go("send")),
    },
    [ERROR_ACTION.RELOAD]: {
      label: "Reload page",
      icon: "rotate-cw",
      onClick: () => window.location.reload(),
    },
    [ERROR_ACTION.HOME]: {
      label: "Back home",
      variant: actionIds.length > 1 ? "secondary" : "primary",
      onClick: goHome,
    },
  };

  return actionIds.map((id) => handlers[id]).filter(Boolean);
}

/**
 * Ends the session with a catalog error. All user-facing wording comes from
 * core/errors.js so every surface stays consistent.
 *
 * @param {string} id Catalog id.
 * @param {{ detail?: string, actions?: string[], diagnostic?: string }} [options]
 */
function failTransfer(id, options = {}) {
  if (app.failureShown) return;
  if (session.phase === "completed") return;
  app.failureShown = true;

  const spec = getErrorSpec(id);

  closeConnections();
  setSession({ phase: "failed" });

  go("error", {
    id,
    detail: options.detail ?? "",
    diagnostic: options.diagnostic ?? "",
    actions: buildErrorActions(options.actions ?? spec.actions, { retryable: spec.retryable }),
  });
}

/** Fails with the catalog entry that matches a signaling-service error. */
function failWithSignalingError(error, fallbackId = "signaling/unreachable") {
  const detail = safeDetail(error);
  if (looksOffline()) {
    failTransfer("network/offline", { detail });
    return;
  }
  failTransfer(errorIdForSignalingCode(error?.code) ?? fallbackId, { detail });
}

/* --------------------------------------------------------------------------
   Signaling wiring
   -------------------------------------------------------------------------- */

/** @param {SignalingClient} signaling */
function wireSignaling(signaling) {
  signaling.addEventListener("ready", () => clearTimer("readyTimer"));

  signaling.addEventListener("message", (event) => {
    if (app.signaling !== signaling) return;
    onSignalingMessage(event.detail);
  });

  signaling.addEventListener("reconnecting", (event) => {
    if (app.signaling !== signaling) return;
    const { attempt } = event.detail;
    app.animation?.setState("reconnecting", `Signaling dropped. Reconnecting (attempt ${attempt})…`);
  });

  // Protocol rejections (a malformed offer/answer/candidate) can never be
  // recovered by reconnecting, so they end the session instead of being
  // swallowed. Transport-level socket errors are left to the close/reconnect
  // path above, which retries before giving up.
  signaling.addEventListener("error", (event) => {
    if (app.signaling !== signaling) return;
    const code = String(event.detail?.error?.code ?? "");
    if (!code.startsWith("invalid_") && code !== "unknown_type") return;
    failTransfer(errorIdForSignalingCode(code), { detail: safeDetail(event.detail?.error) });
  });

  signaling.addEventListener("close", (event) => {
    if (app.signaling !== signaling || event.detail.byUs) return;
    // The client retries on its own; if it never comes back, end the session.
    window.setTimeout(() => {
      if (app.signaling !== signaling) return;
      if (signaling.socket) return;
      if (session.phase === "completed") return;
      failTransfer(looksOffline() ? "network/offline" : "signaling/lost");
    }, 6500);
  });
}

/** @param {Record<string, any>} message */
function onSignalingMessage(message) {
  switch (message.type) {
    case "ready": {
      const peers = message.peers ?? {};
      if (app.role === "sender" && peers.receiver) {
        // Reconnected into a room that already has a receiver.
        onPeerJoined("receiver");
      }
      break;
    }
    case "peer_joined":
      onPeerJoined(String(message.role ?? ""));
      break;
    case "peer_left":
      onPeerLeft(String(message.role ?? ""));
      break;
    case "offer":
      void onOfferReceived(message.sdp);
      break;
    case "answer":
      void onAnswerReceived(message.sdp);
      break;
    case "ice":
      void app.peer?.addRemoteCandidate(message.candidate);
      break;
    case "receiver_accept":
      // Informational: file data is gated by the in-band accept message.
      break;
    case "receiver_reject":
      onReceiverRejected();
      break;
    case "room_closed":
      onRoomClosed(String(message.reason ?? "closed"));
      break;
    default:
      break;
  }
}

function onPeerJoined(role) {
  if (role !== "receiver" || app.role !== "sender") return;
  clearTimer("graceTimer");
  if (app.transport?.isOpen) return; // already connected (reconnect event)

  app.animation?.setReceiverPresent(true);
  app.animation?.setState("negotiating");
  setSession({ phase: "negotiating" });
  void sendOffer();
}

async function sendOffer() {
  if (app.role !== "sender" || !app.signaling) return;
  try {
    const peer = createSenderPeer();
    const offer = await peer.createOffer();
    if (!offer?.sdp) throw new Error("The browser did not produce a session offer.");
    app.signaling.send({ type: "offer", sdp: offer.sdp });
    clearTimer("connectTimer");
    app.connectTimer = window.setTimeout(
      () => onConnectionTimeout(),
      config.connectTimeoutMs,
    );
  } catch (error) {
    failTransfer("connection/failed", { detail: safeDetail(error) });
  }
}

/** True when a TURN relay is configured, which changes what a failure means. */
function hasRelayConfigured() {
  return config.iceServers.some((server) =>
    [server.urls ?? []].flat().some((url) => String(url).startsWith("turn")),
  );
}

function createSenderPeer() {
  app.transport?.close();
  app.peer?.close();
  app.transport = null;

  const peer = new PeerConnection({ role: "sender", iceServers: config.iceServers });
  app.peer = peer;
  bindPeerEvents(peer);
  bindChannel(peer.createDataChannel("droply-files"));
  return peer;
}

function createReceiverPeer() {
  const peer = new PeerConnection({ role: "receiver", iceServers: config.iceServers });
  app.peer = peer;
  bindPeerEvents(peer);
  return peer;
}

/** @param {PeerConnection} peer */
function bindPeerEvents(peer) {
  peer.addEventListener("icecandidate", (event) => {
    if (app.peer !== peer) return;
    app.signaling?.send({ type: "ice", candidate: event.detail.candidate });
  });

  peer.addEventListener("statechange", (event) => {
    if (app.peer !== peer) return;
    const { connectionState } = event.detail;
    if (connectionState === "connecting" && !app.transport?.isOpen) {
      app.animation?.setState("connecting");
    }
    if (connectionState === "failed") onPeerFailed();
  });

  peer.addEventListener("datachannel", (event) => {
    if (app.peer !== peer || app.role !== "receiver") return;
    bindChannel(event.detail.channel);
  });
}

function onConnectionTimeout() {
  if (app.transport?.isOpen) return;
  if (app.role === "sender" && app.retryAttempts < 1) {
    app.retryAttempts += 1;
    app.animation?.setState("negotiating", "First attempt timed out. Retrying with a fresh negotiation…");
    void sendOffer();
    return;
  }
  // Without a relay, a timeout on both sides usually means the NAT blocks a
  // direct route, so the advice is different from a plain slow connection.
  failTransfer(hasRelayConfigured() ? "connection/timeout" : "connection/relay-needed");
}

function onPeerFailed() {
  if (app.transport?.isOpen) {
    failTransfer("connection/interrupted");
    return;
  }
  if (app.role === "sender" && app.retryAttempts < 1) {
    app.retryAttempts += 1;
    app.animation?.setState("negotiating", "Retrying with a fresh negotiation…");
    void sendOffer();
    return;
  }
  failTransfer(hasRelayConfigured() ? "connection/failed" : "connection/relay-needed");
}

async function onOfferReceived(sdp) {
  if (app.role !== "receiver") return;
  if (!isProbablySdp(sdp)) {
    failTransfer("connection/failed", { detail: "Invalid session offer received." });
    return;
  }
  if (app.receiver?.state === "receiving" || session.phase === "transferring") {
    // Never tear down an in-flight transfer for a stray re-offer.
    return;
  }

  app.animation?.setState("negotiating");
  setSession({ phase: "negotiating" });
  app.transport?.close();
  app.peer?.close();
  app.transport = null;

  const peer = createReceiverPeer();
  try {
    const answer = await peer.acceptOffer({ type: "offer", sdp });
    if (!answer?.sdp) throw new Error("The browser did not produce an answer.");
    app.signaling?.send({ type: "answer", sdp: answer.sdp });
    clearTimer("connectTimer");
    app.connectTimer = window.setTimeout(
      () => onConnectionTimeout(),
      config.connectTimeoutMs + 15_000,
    );
  } catch (error) {
    failTransfer("connection/failed", { detail: safeDetail(error) });
  }
}

async function onAnswerReceived(sdp) {
  if (app.role !== "sender") return;
  if (!app.peer) return;
  if (!isProbablySdp(sdp)) {
    failTransfer("connection/failed", { detail: "Invalid session answer received." });
    return;
  }
  try {
    await app.peer.acceptAnswer({ type: "answer", sdp });
  } catch (error) {
    failTransfer("connection/failed", { detail: safeDetail(error) });
  }
}

function onPeerLeft(role) {
  if (role !== "receiver" || app.role !== "sender") {
    if (role === "sender" && app.role === "receiver") {
      failTransfer("peer/sender-left");
    }
    return;
  }

  if (app.deliveryConfirmed || session.phase === "completed") return;

  app.animation?.setState("reconnecting", "The receiver disconnected. Waiting for them to rejoin…");
  app.transferView?.setStatus({ label: "Receiver disconnected", tone: "red" });
  clearTimer("graceTimer");
  app.graceTimer = window.setTimeout(() => {
    if (app.deliveryConfirmed || session.phase === "completed") return;
    failTransfer("peer/receiver-left");
  }, 8000);
}

function onRoomClosed(reason) {
  if (session.phase === "completed") return;
  switch (reason) {
    case "completed":
      // The sender deleted the room after a transfer this tab never finished.
      // Leaving the waiting screen up would strand the user on a dead room.
      failTransfer("connection/interrupted");
      break;
    case "expired":
      failTransfer("room/expired");
      break;
    case "cancelled":
      failTransfer("transfer/cancelled");
      break;
    case "rejected":
      onReceiverRejected();
      break;
    case "receiver-left":
      failTransfer("peer/receiver-left");
      break;
    case "sender-left":
      failTransfer("peer/sender-left");
      break;
    default:
      failTransfer("room/closed");
      break;
  }
}

function onReceiverRejected() {
  failTransfer("peer/rejected");
}

/* --------------------------------------------------------------------------
   Data channel
   -------------------------------------------------------------------------- */

/** @param {RTCDataChannel} channel */
function bindChannel(channel) {
  const transport = new DataChannelTransport(channel);
  app.transport = transport;

  transport.addEventListener("open", onChannelOpen);
  transport.addEventListener("close", onChannelClose);
  transport.addEventListener("control", (event) => onChannelControl(event.detail));
  transport.addEventListener("chunk", (event) => app.receiver?.handleChunk(event.detail));
  transport.addEventListener("protocolerror", (event) => {
    failTransfer("transfer/failed", { detail: safeDetail(event.detail?.message) });
  });
}

function onChannelOpen() {
  clearTimer("connectTimer");
  app.animation?.setState("connected");
  setSession({ phase: "connected" });
  if (app.role === "sender") onSenderChannelOpen();
  else onReceiverChannelOpen();
}

function onChannelClose() {
  if (session.phase === "completed" || app.failureShown) return;
  if (app.deliveryConfirmed) return;
  if (app.role === "receiver" && app.receiver?.state === "complete") return;

  clearTimer("closeTimer");
  app.closeTimer = window.setTimeout(() => {
    if (app.transport?.isOpen || app.deliveryConfirmed) return;
    if (session.phase === "completed") return;
    failTransfer("connection/interrupted");
  }, 2500);
}

function onSenderChannelOpen() {
  const sender = new FileSender({ transport: app.transport, files: app.senderFiles });
  app.sender = sender;
  app.senderBytes = sender.totalBytes;

  sender.addEventListener("progress", (event) => app.transferView?.update(event.detail));
  sender.addEventListener("error", (event) => {
    const message = String(event.detail?.message ?? "");
    failTransfer(/read|file/i.test(message) ? "file/read-denied" : "transfer/failed", {
      detail: safeDetail(message),
    });
  });
  sender.addEventListener("complete", onSenderBytesComplete);

  try {
    sender.sendManifest();
  } catch (error) {
    failTransfer("transfer/failed", { detail: safeDetail(error) });
    return;
  }

  go("transfer", { mode: "send", files: app.senderFiles });
  app.transferView?.setStatus({ label: "Waiting for approval", tone: "blue" });
  app.transferView?.update({
    ratio: 0,
    transferredBytes: 0,
    totalBytes: sender.totalBytes,
    speed: 0,
    eta: null,
    complete: false,
    files: sender.entries.map((entry) => ({
      ratio: 0,
      transferred: 0,
      size: entry.size,
      state: "pending",
    })),
  });

  void app.peer?.describePath().then(({ path }) => app.transferView?.setPath(path));

  // Sending starts only when the receiver's ACCEPT control message arrives
  // (see onChannelControl). Nothing is transmitted before that consent.
  addUnloadGuard();
}

function onSenderBytesComplete(event) {
  app.transferView?.update(event.detail.detail);
  app.transferView?.setStatus({ label: "Awaiting confirmation", tone: "blue" });
  clearTimer("confirmTimer");
  app.confirmTimer = window.setTimeout(() => {
    if (app.deliveryConfirmed) return;
    failTransfer("transfer/unconfirmed");
  }, 10_000);
}

function beginSending() {
  if (app.role !== "sender" || !app.sender || app.sender.started) return;
  try {
    app.sender.markAccepted();
    app.senderBytes = app.sender.totalBytes;
    app.transferStartedAt = performance.now();
    app.transferView?.setStatus({ label: "Sending", tone: "blue" });
    setSession({ phase: "transferring" });
    addUnloadGuard();
    void app.sender.start();
  } catch (error) {
    failTransfer("transfer/failed", { detail: safeDetail(error) });
  }
}

function onDeliveryConfirmed() {
  if (app.role !== "sender" || app.deliveryConfirmed) return;
  app.deliveryConfirmed = true;
  clearTimer("confirmTimer");
  clearTimer("graceTimer");

  app.transferView?.markComplete();
  setSession({ phase: "completed" });

  // Ask the signaling service to delete the room now that both sides agree.
  app.signaling?.send({ type: "complete" });
  const files = app.senderFiles.map((file) => ({ name: file.name, size: file.size }));
  const elapsed = app.transferStartedAt
    ? (performance.now() - app.transferStartedAt) / 1000
    : undefined;

  const signaling = app.signaling;
  closeConnections({ keepSignaling: true });
  window.setTimeout(() => signaling?.close(), 900);
  app.signaling = null;

  go("complete", {
    mode: "send",
    files,
    totalBytes: app.senderBytes,
    elapsed,
  });
}

function onReceiverChannelOpen() {
  const receiver = new FileReceiver({ transport: app.transport });
  app.receiver = receiver;

  receiver.addEventListener("manifest", (event) => {
    app.animation?.setState("connected");
    go("incoming", {
      files: event.detail.files,
      totalBytes: event.detail.totalBytes,
    });
  });

  receiver.addEventListener("progress", (event) => app.transferView?.update(event.detail));
  receiver.addEventListener("file-complete", () => {
    /* Rows are updated from the aggregated progress event. */
  });
  receiver.addEventListener("complete", onReceiverComplete);
  receiver.addEventListener("error", (event) => {
    const message = String(event.detail?.message ?? "");
    // A byte-count mismatch is an integrity failure, not a generic one.
    failTransfer(
      /integrity|byte count|size mismatch/i.test(message) ? "transfer/integrity" : "transfer/failed",
      { detail: safeDetail(message) },
    );
  });
  receiver.addEventListener("cancelled", (event) => {
    if (session.phase === "completed") return;
    const reason = event.detail?.reason;
    if (reason === "sender-cancelled" || reason === "cancelled") {
      failTransfer("transfer/cancelled");
    } else {
      failTransfer("transfer/interrupted");
    }
  });

  app.animation?.setDetail("Connected. Waiting for the sender to describe the files…");
}

function onReceiverComplete(event) {
  const { files, totalBytes, elapsed } = event.detail;
  app.receivedFiles = files;
  app.receivedBytes = totalBytes;
  app.receivedElapsed = elapsed;
  setSession({ phase: "completed" });
  app.transferView?.markComplete();

  closeConnections({ keepReceiver: true });
  go("complete", {
    mode: "receive",
    files,
    totalBytes,
    elapsed,
  });
}

/** @param {Record<string, any>} message */
function onChannelControl(message) {
  // On the receiving side every control frame belongs to the transfer engine:
  // manifest, file boundaries, completion, cancellation and peer errors.
  if (app.role === "receiver") {
    app.receiver?.handleControl(message);
    return;
  }

  switch (message.t) {
    case CONTROL.ACCEPT:
      if (app.role === "sender") {
        app.pendingAccept = true;
        beginSending();
      }
      break;
    case CONTROL.REJECT:
      if (app.role === "sender") onReceiverRejected();
      break;
    case CONTROL.CONFIRMED:
      if (app.role === "sender") onDeliveryConfirmed();
      break;
    case CONTROL.CANCEL:
      failTransfer("transfer/cancelled");
      break;
    case CONTROL.ERROR:
      failTransfer("transfer/failed", { detail: safeDetail(message.message) });
      break;
    default:
      break;
  }
}

/* --------------------------------------------------------------------------
   Sender flow
   -------------------------------------------------------------------------- */

/**
 * @param {File[]} files
 */
async function createTransfer(files) {
  resetRuntime();
  app.senderFiles = files;
  setSession({ role: "sender", files, phase: "waiting" });

  const signaling = new SignalingClient();
  app.signaling = signaling;
  wireSignaling(signaling);

  clearTimer("readyTimer");
  app.readyTimer = window.setTimeout(() => {
    if (app.signaling === signaling && !signaling.ready) {
      failTransfer(looksOffline() ? "network/offline" : "signaling/unreachable");
    }
  }, 15_000);

  try {
    const room = await signaling.createRoom();
    if (app.signaling !== signaling) return;

    app.role = "sender";
    app.code = room.code;
    setSession({ code: room.code, expiresAt: room.expiresAt });

    go("waiting", {
      code: room.code,
      receiveUrl: receiveLink(room.code),
      expiresAt: room.expiresAt,
    });
    addUnloadGuard();
    signaling.connect({ code: room.code, token: room.token });
  } catch (error) {
    clearTimer("readyTimer");
    if (session.phase !== "failed") {
      resetRuntime();
      setSession({ role: "sender", files, phase: "failed" });
      app.senderFiles = files;
      app.role = "sender";
      app.failureShown = false;
      failWithSignalingError(error);
    }
  }
}

/* --------------------------------------------------------------------------
   Receiver flow
   -------------------------------------------------------------------------- */

/**
 * @param {string} code
 */
async function joinRoom(code) {
  resetRuntime();
  app.role = "receiver";
  app.code = code;
  setSession({ role: "receiver", code, phase: "joining" });

  go("connecting", { code });
  addUnloadGuard();

  const signaling = new SignalingClient();
  app.signaling = signaling;
  wireSignaling(signaling);

  try {
    const room = await signaling.joinRoom(code);
    if (app.signaling !== signaling) return;
    setSession({ expiresAt: room.expiresAt });
    signaling.connect({ code, token: room.token });

    clearTimer("readyTimer");
    app.readyTimer = window.setTimeout(() => {
      if (app.signaling === signaling && !signaling.ready) {
        failTransfer(looksOffline() ? "network/offline" : "signaling/lost");
      }
    }, 15_000);

    clearTimer("connectTimer");
    app.connectTimer = window.setTimeout(() => {
      if (app.transport?.isOpen) return;
      failTransfer(hasRelayConfigured() ? "connection/timeout" : "connection/relay-needed");
    }, config.connectTimeoutMs + 20_000);
  } catch (error) {
    const errorId = looksOffline() ? "network/offline" : errorIdForSignalingCode(error?.code);
    resetRuntime();
    resetSession();
    setSession({ role: "receiver", code });
    app.role = "receiver";
    app.code = code;
    app.failureShown = false;

    // Wrong / dead codes stay on the input; anything else gets a full page.
    if (isCodeError(errorId) && isPageError(errorId) === false) {
      go("code", { initialCode: code, errorId });
    } else {
      failTransfer(errorId, { detail: safeDetail(error) });
    }
  }
}

/* --------------------------------------------------------------------------
   User actions shared by screens
   -------------------------------------------------------------------------- */

function cancelTransfer() {
  const message = "Transfer cancelled. The room has been closed.";
  try {
    if (app.role === "sender") {
      app.sender?.cancel();
      app.signaling?.send({ type: "cancel" });
    } else if (app.role === "receiver") {
      app.receiver?.cancel();
      app.signaling?.send({ type: "cancel" });
    }
  } catch {
    /* best effort */
  }
  clearAllTimers();
  closeConnections();
  resetSession();
  go("home");
  errorToast("transfer/cancelled");
}

function retrySendWithSameFiles() {
  if (!app.senderFiles.length) {
    go("send");
    return;
  }
  void createTransfer(app.senderFiles);
}

/* --------------------------------------------------------------------------
   Routes
   -------------------------------------------------------------------------- */

function registerRoutes() {
  registerRoute("home", () =>
    mountHome({
      onSend: () => {
        app.senderFiles = [];
        go("send");
      },
      onReceive: () => go("receive"),
    }),
  );

  registerRoute("send", (params) => {
    const view = mountFileSelection({
      files: params.files ?? app.senderFiles,
      onBack: goHome,
      onCreate: (files) => {
        app.senderFiles = files;
        void createTransfer(files);
      },
    });
    app.selectionView = view;
    return view;
  });

  registerRoute("waiting", (params) => {
    const view = mountSenderWaiting({
      code: String(params.code ?? ""),
      receiveUrl: String(params.receiveUrl ?? ""),
      // Numbers are epoch milliseconds; strings are ISO timestamps. Neither
      // may be stringified here or the countdown breaks.
      expiresAt: params.expiresAt ?? null,
      onCancel: cancelTransfer,
    });
    app.animation = view.animation;
    return view;
  });

  registerRoute("receive", () =>
    mountReceiveChoice({
      onScan: () => go("scan"),
      onCode: () => go("code"),
      onBack: goHome,
    }),
  );

  registerRoute("scan", () =>
    mountQrScanner({
      onBack: () => go("receive"),
      onCode: () => go("code"),
      onDetected: (code) => void joinRoom(code),
    }),
  );

  registerRoute("code", (params) => {
    const view = mountCodeEntry({
      initialCode: String(params.initialCode ?? ""),
      onBack: () => go("receive"),
      onSubmit: (code) => void joinRoom(code),
      onScanInstead: () => go("scan"),
    });
    if (params.errorId) {
      window.setTimeout(() => view.showError(String(params.errorId)), 80);
    }
    return view;
  });

  registerRoute("connecting", (params) => {
    const animation = new ConnectionAnimation({ role: "receiver", state: "joining" });
    const element = el(`
      <section class="screen" aria-labelledby="connecting-title">
        <div class="stage stage--narrow">
          <div class="back-row">
            <span class="pill pill--blue">Receive</span>
            <span class="pill mono">${escapeHtml(String(params.code ?? ""))}</span>
          </div>
          <div class="screen-head screen-head--center">
            <h1 id="connecting-title">Connecting to the sender</h1>
            <p>Pairing the two devices. This usually takes a few seconds.</p>
          </div>
          <div data-animation></div>
          <div class="btn-group" style="justify-content: center">
            <button type="button" class="btn btn--ghost btn--sm" data-cancel>Cancel</button>
          </div>
        </div>
      </section>
    `);
    element.querySelector("[data-animation]").appendChild(animation.element);
    element.querySelector("[data-cancel]").addEventListener("click", cancelTransfer);
    app.animation = animation;
    return { element, title: "Connecting", animation };
  });

  registerRoute("incoming", (params) =>
    mountIncomingTransfer({
      files: params.files ?? [],
      totalBytes: Number(params.totalBytes) || 0,
      onAccept: () => {
        if (!app.receiver || app.receiver.state !== "awaiting-consent") return;
        try {
          app.receiver.accept();
          setSession({ phase: "transferring" });
          app.transferStartedAt = performance.now();
          go("transfer", { mode: "receive", files: params.files ?? [] });
          app.transferView?.setStatus({ label: "Receiving", tone: "blue" });
          if (app.receiver.receivedBytes > 0) {
            app.transferView?.update({
              ratio: 0,
              transferredBytes: 0,
              totalBytes: Number(params.totalBytes) || 0,
              speed: 0,
              eta: null,
              complete: false,
              files: (params.files ?? []).map((file) => ({
                ratio: 0,
                transferred: 0,
                size: file.size,
                state: "pending",
              })),
            });
          }
          void app.peer?.describePath().then(({ path }) => app.transferView?.setPath(path));
        } catch (error) {
          failTransfer("transfer/failed", { detail: safeDetail(error) });
        }
      },
      onReject: () => {
        app.receiver?.reject();
        app.signaling?.send({ type: "receiver_reject" });
        closeConnections();
        resetSession();
        go("home");
        toast("Transfer rejected. The room is closed.");
      },
    }),
  );

  registerRoute("transfer", (params) => {
    const view = mountTransfer({
      mode: params.mode === "receive" ? "receive" : "send",
      files: params.files ?? [],
      onCancel: cancelTransfer,
    });
    app.transferView = view;
    return view;
  });

  registerRoute("complete", (params) =>
    mountTransferComplete({
      mode: params.mode === "receive" ? "receive" : "send",
      files: params.files ?? [],
      totalBytes: Number(params.totalBytes) || 0,
      elapsedSeconds: params.elapsed,
      onDone: goHome,
    }),
  );

  registerRoute("error", (params) =>
    mountErrorPage({
      id: String(params.id ?? DEFAULT_ERROR_ID),
      detail: String(params.detail ?? ""),
      diagnostic: String(params.diagnostic ?? ""),
      actions: params.actions ?? buildErrorActions([ERROR_ACTION.HOME]),
    }),
  );
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

function parseDeepLink() {
  const hash = window.location.hash || "";
  const search = new URLSearchParams(window.location.search);
  let code = null;

  // A bare receive link (shared by hand, without a code) is still useful:
  // it opens the receive screen instead of dropping the visitor on home.
  if (hash === "#/receive" || hash === "#/receive/") {
    history.replaceState(null, "", window.location.pathname);
    go("receive");
    return true;
  }

  if (hash.startsWith("#/receive")) code = extractRoomCode(hash);
  else if (search.has("code")) code = extractRoomCode(search.get("code") ?? "");

  if (!code) {
    // Clear an unusable link so reloading does not loop.
    if (hash.startsWith("#/receive") || search.has("code")) {
      history.replaceState(null, "", window.location.pathname);
    }
    return false;
  }

  history.replaceState(null, "", window.location.pathname);
  void joinRoom(code);
  return true;
}

function showUnsupportedBrowser() {
  go("error", {
    id: isSecureContext() ? "browser/unsupported" : "browser/insecure",
    actions: buildErrorActions([ERROR_ACTION.RELOAD]),
  });
}

function wireGlobalUi() {
  bindInfoDialogs();

  const brand = document.querySelector(".brand");
  brand?.addEventListener("click", (event) => {
    event.preventDefault();
    if (isActive()) {
      toast("Finish or cancel the active transfer first.");
      return;
    }
    goHome();
  });

  const header = document.getElementById("site-header");
  if (header) {
    const onScroll = () => {
      header.dataset.scrolled = String(window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Surface configuration problems early instead of failing mid-transfer.
  if (!isSecureContext()) {
    console.warn("[droply] insecure context: WebRTC and camera may be blocked.");
  }

  /* ------------------------------------------------------------------------
     Network evidence. navigator.onLine is a hint, not proof, so it is only
     trusted together with a real failure (a dropped socket or a failed
     request) — see failWithSignalingError().
     ---------------------------------------------------------------------- */
  window.addEventListener("offline", () => {
    if (!isActive()) return;
    failTransfer("network/offline");
  });

  window.addEventListener("online", () => {
    if (session.phase !== "failed") return;
    toast("You're back online. Start the transfer again when you're ready.", { tone: "success" });
  });

  /* ------------------------------------------------------------------------
     Last-resort handlers: an unexpected exception must never leave the UI
     stuck on a progress bar that will not move. The diagnostic id is safe to
     share and is also logged locally for debugging.
     ---------------------------------------------------------------------- */
  function reportUnexpected(error) {
    const diagnostic = createDiagnosticId();
    console.error(`[droply] unexpected error (${diagnostic})`, error);
    if (!isActive()) return;
    failTransfer("app/unexpected", { diagnostic, detail: safeDetail(error) });
  }

  window.addEventListener("error", (event) => {
    if (!event.error) return; // resource load failures are not app errors
    reportUnexpected(event.error);
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportUnexpected(event.reason);
  });
}

function runIntro() {
  const intro = document.getElementById("intro");
  if (!intro) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.setTimeout(
    () => {
      intro.dataset.exiting = "true";
      window.setTimeout(() => intro.remove(), reduced ? 0 : 620);
    },
    reduced ? 300 : 950,
  );
}

function boot() {
  registerRoutes();
  wireGlobalUi();
  runIntro();

  if (!isWebRtcSupported()) {
    showUnsupportedBrowser();
    return;
  }

  if (!parseDeepLink()) {
    go("home");
  }

  // A shared receive link clicked while Droply is already open in this tab is a
  // same-document navigation, so no reload happens. Honour the new fragment
  // unless a transfer is in flight (never yank the user out of a live session).
  window.addEventListener("hashchange", () => {
    if (isActive()) return;
    parseDeepLink();
  });
}

boot();

// Exposed for manual debugging in the console; holds no file contents.
if (typeof window !== "undefined") {
  window.__droply = {
    get phase() {
      return session.phase;
    },
    get role() {
      return session.role;
    },
    get config() {
      return { ...config, iceServers: config.iceServers };
    },
    get stats() {
      return {
        sent: app.senderBytes,
        received: app.receivedBytes,
        files: app.receivedFiles.length,
        signalingReady: Boolean(app.signaling?.ready),
        channelOpen: Boolean(app.transport?.isOpen),
        path: app.peer ? "see describePath()" : "none",
        transferSize: formatBytes(app.receivedBytes || app.senderBytes),
      };
    },
  };
}
