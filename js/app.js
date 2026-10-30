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
import { extractRoomCode, isProbablySdp, isValidCode } from "./utils/validation.js";
import { formatBytes } from "./utils/format-bytes.js";
import { mountNearby } from "./ui/nearby-view.js";
import { mountSavedDevices } from "./ui/saved-devices-view.js";
import { mountPairing } from "./ui/pairing-view.js";
import { mountInvite } from "./ui/invite-view.js";
import { mountProfile } from "./ui/profile-view.js";
import { PresenceClient } from "./core/presence-client.js";
import { createIndexedDbStore } from "./core/storage/store.js";
import { loadDeviceIdentity } from "./core/device-identity.js";
import { parseDeviceMetadata } from "./core/device-profile.js";
import { SavedDevices } from "./core/saved-devices.js";
import { createInvite, isInviteShape, isValidPairingCode, normalizePairingCode, verifyInvite } from "./core/pairing.js";

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

  /* Saved devices / nearby (browser-local, never sent to a server except the
     opt-in presence record itself). */
  /** @type {import("./core/storage/store.js").KeyValueStore|null} */
  storage: null,
  /** @type {SavedDevices|null} */
  savedDevices: null,
  /** @type {Awaited<ReturnType<typeof loadDeviceIdentity>>|null} */
  identity: null,
  /** @type {Promise<any>|null} */
  identityPromise: null,
  /** @type {Array<any>} */
  savedDeviceCache: [],
  /** @type {PresenceClient|null} */
  presence: null,
  presencePhase: "offline",
  /** @type {{render:Function}|null} */
  nearbyView: null,
  /** @type {{render:Function}|null} */
  savedView: null,
  /** @type {object|null} */
  pairingView: null,
  /** @type {object|null} */
  inviteView: null,
  /** @type {{kind:"nearby"|"saved", peerId?:string, deviceId:string, name:string}|null} */
  pendingTarget: null,
  /** @type {object|null} */
  pendingInvite: null,
  /** @type {{deviceId:string, name:string}|null} */
  senderTarget: null,
  connectedDeviceId: null,
  /** Public profile of the device on the other end of the live transfer. */
  /** @type {object|null} */
  peerIdentity: null,
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
  app.peerIdentity = null;
  app.scope.dispose();
  app.scope = new ResourceScope();
}

function goHome() {
  stopPresence();
  app.connectedDeviceId = null;
  app.pendingTarget = null;
  app.pendingInvite = null;
  resetRuntime();
  resetSession();
  go("home");
}

/* --------------------------------------------------------------------------
   Saved devices, pairing and nearby presence

   Presence is opt-in and relayed only through the Droply Worker. It carries
   device metadata and signed invites — never file bytes, room tokens or IP
   addresses. Leaving Droply stops it (see the pagehide handler below).
   -------------------------------------------------------------------------- */

function onlineDeviceIds() {
  return (app.presence?.peers ?? []).map((peer) => peer.deviceId).filter(Boolean);
}

async function ensureIdentity() {
  if (app.identity) return app.identity;
  if (!app.storage) app.storage = createIndexedDbStore();
  if (!app.savedDevices) app.savedDevices = new SavedDevices({ store: app.storage });
  if (!app.identityPromise) {
    app.identityPromise = loadDeviceIdentity({ store: app.storage }).catch((error) => {
      app.identityPromise = null;
      throw error;
    });
  }
  app.identity = await app.identityPromise;
  return app.identity;
}

/** The public profile shown in this tab's own screens. */
function selfIdentity() {
  return app.identity?.profile ?? null;
}

function refreshSavedView(patch = {}) {
  if (!app.savedView) return;
  app.savedView.render({
    devices: app.savedDeviceCache,
    online: onlineDeviceIds(),
    reachable: Boolean(app.presence && !app.presence.stopped),
    presencePhase: app.presencePhase,
    ...patch,
  });
}

async function loadSavedDevices() {
  try {
    await ensureIdentity();
    app.savedDeviceCache = await app.savedDevices.list();
  } catch (error) {
    app.savedDeviceCache = [];
    refreshSavedView({
      error: error?.message ?? "Saved devices aren't available in this browser.",
    });
    return [];
  }
  refreshSavedView();
  return app.savedDeviceCache;
}

function nearbyPhaseFor(phase) {
  return ["starting", "online", "reconnecting", "offline"].includes(phase) ? phase : "idle";
}

/** Lazily creates the single presence session and wires its events. */
async function ensurePresence() {
  if (app.presence) return app.presence;
  const identity = await ensureIdentity();
  const client = new PresenceClient({ identity });
  app.presence = client;

  client.addEventListener("status", (event) => {
    if (app.presence !== client) return;
    app.presencePhase = event.detail.phase;
    app.nearbyView?.render({ phase: nearbyPhaseFor(event.detail.phase) });
    refreshSavedView();
  });

  client.addEventListener("peers", (event) => {
    if (app.presence !== client) return;
    app.nearbyView?.render({
      phase: nearbyPhaseFor(app.presencePhase),
      peers: event.detail.peers,
    });
    refreshSavedView();
  });

  client.addEventListener("invite", (event) => {
    if (app.presence !== client) return;
    void handlePresenceInvite(event.detail);
  });

  client.addEventListener("invite-sent", (event) => {
    if (app.presence !== client) return;
    if (!event.detail.delivered) {
      toast("That device isn't reachable. Share the transfer code instead.", { tone: "danger" });
    }
  });

  client.addEventListener("invite-response", (event) => {
    if (app.presence !== client) return;
    if (!event.detail.accepted) toast("The other device declined the request.");
  });

  client.addEventListener("error", (event) => {
    if (app.presence !== client) return;
    app.nearbyView?.render({
      phase: nearbyPhaseFor(app.presencePhase),
      error: event.detail?.error?.message,
    });
  });

  return client;
}

function stopPresence() {
  if (!app.presence) return;
  app.presence.stop();
  app.presence = null;
  app.presencePhase = "offline";
}

async function startNearbyDiscovery() {
  app.nearbyView?.render({ phase: "starting" });
  try {
    const client = await ensurePresence();
    await client.start();
    if (client.stopped || !client.isOnline) {
      app.presencePhase = "offline";
      app.nearbyView?.render({ phase: "offline", peers: [] });
      return;
    }
    app.presencePhase = "online";
    app.nearbyView?.render({
      phase: "online",
      peers: client.peers,
      available: client.available,
    });
    refreshSavedView();
  } catch (error) {
    app.presencePhase = "offline";
    app.nearbyView?.render({
      phase: "offline",
      peers: [],
      error: error?.message ?? "Nearby discovery didn't start.",
    });
  }
}

function stopNearbyDiscovery() {
  stopPresence();
  app.nearbyView?.render({ phase: "offline", peers: [] });
  refreshSavedView();
}

async function setReachable(enabled) {
  if (!enabled) {
    stopPresence();
    refreshSavedView({ notice: "Reachability is off. Saved devices can't reach you until you turn it on again." });
    return;
  }
  try {
    const client = await ensurePresence();
    await client.start();
    if (client.stopped || !client.isOnline) {
      refreshSavedView({
        reachable: false,
        error: "Reachability did not start. Try again.",
      });
      return;
    }
    refreshSavedView({
      reachable: true,
      presencePhase: app.presencePhase,
      notice: "This device is reachable by your saved devices until you leave Droply or switch it off.",
    });
    app.nearbyView?.render({ phase: nearbyPhaseFor(app.presencePhase) });
  } catch (error) {
    refreshSavedView({
      reachable: false,
      error: error?.message ?? "This device could not be made reachable.",
    });
  }
}

/** Sends a signed invite for a freshly created room to one peer. */
async function deliverInvite(target, code) {
  if (!target) return;
  try {
    let client = app.presence;
    if (!client && target.kind === "saved") {
      client = await ensurePresence();
      await client.start();
    }
    const peerId =
      target.peerId ||
      client?.peers.find((peer) => peer.deviceId === target.deviceId)?.peerId ||
      null;
    if (!peerId || !client?.isOnline) {
      toast(`${target.name} isn't reachable right now. Share the code instead.`, {
        tone: "danger",
      });
      return;
    }
    const identity = await ensureIdentity();
    const invite = await createInvite(identity, { to: peerId, code });
    if (client.sendInvite(peerId, invite)) {
      app.connectedDeviceId = target.deviceId;
      toast(`Invite sent to ${target.name}.`);
    }
  } catch (error) {
    toast(error?.message ?? "The invite could not be sent.");
  }
}

async function handlePresenceInvite({ from, invite }) {
  if (!from || typeof from.peerId !== "string") return;
  if (!isInviteShape(invite)) return;

  // A live transfer always wins over a new request.
  if (isActive() || app.receiver) {
    app.presence?.respondInvite(from.peerId, false);
    toast("You're already in a transfer, so the request was declined.", { tone: "danger" });
    return;
  }

  let saved = null;
  try {
    saved = (await app.savedDevices?.find(invite.fromDeviceId)) ?? null;
  } catch {
    saved = null;
  }

  let verified = false;
  if (saved) {
    try {
      verified = await verifyInvite(saved.publicKey, invite);
    } catch {
      verified = false;
    }
    if (!verified) {
      // A request that claims a saved identity but fails its signature is
      // dropped: it must never appear as that trusted device.
      app.presence?.respondInvite(from.peerId, false);
      toast("A nearby request failed identity verification and was declined.", { tone: "danger" });
      return;
    }
  }

  // The invite's display fields are inside the signature, so a verified
  // request may also refresh the saved contact's name and avatar.
  let display = saved;
  if (saved && verified) {
    try {
      const updated = await app.savedDevices.updateIdentity(saved.deviceId, {
        name: invite.fromName,
        avatar: invite.fromAvatar,
        deviceType: invite.fromDeviceType,
        platform: invite.fromPlatform,
        browser: invite.fromBrowser,
      });
      if (updated) {
        display = updated;
        app.savedDeviceCache = await app.savedDevices.list();
        refreshSavedView();
      }
    } catch {
      /* the stored copy stays as-is if it cannot be refreshed */
    }
  }

  app.pendingInvite = {
    invite,
    fromPeerId: from.peerId,
    deviceId: saved?.deviceId ?? invite.fromDeviceId,
    verified,
    name: display?.name ?? from.name ?? invite.fromName,
    deviceType: display?.deviceType ?? from.deviceType ?? "",
    platform: display?.platform ?? from.platform ?? "",
    browser: display?.browser ?? from.browser ?? "",
    avatar: display?.avatar ?? from.avatar ?? invite.fromAvatar ?? "generic",
    origin: saved ? "saved" : "nearby",
  };
  go("invite", app.pendingInvite);
}

function markConnectedDeviceSeen() {
  if (!app.connectedDeviceId || !app.savedDevices) return;
  app.savedDevices
    .markSeen(app.connectedDeviceId)
    .then(() => loadSavedDevices())
    .catch(() => {});
}

async function sendToSavedDevice(deviceId) {
  const devices = await loadSavedDevices();
  const device = devices.find((item) => item.deviceId === deviceId);
  if (!device) {
    refreshSavedView({ error: "That saved device no longer exists." });
    return;
  }
  app.pendingTarget = {
    kind: "saved",
    deviceId: device.deviceId,
    name: device.name,
    deviceType: device.deviceType,
    platform: device.platform,
    browser: device.browser,
    avatar: device.avatar,
  };
  go("send");
}

async function removeSavedDevice(id) {
  try {
    await ensureIdentity();
    await app.savedDevices.remove(id);
    app.savedDeviceCache = await app.savedDevices.list();
    refreshSavedView({ notice: "Device removed from this browser." });
  } catch (error) {
    refreshSavedView({ error: error?.message ?? "That device could not be removed." });
  }
}

async function renameSavedDevice(id, name) {
  try {
    await ensureIdentity();
    await app.savedDevices.rename(id, name);
    app.savedDeviceCache = await app.savedDevices.list();
    refreshSavedView({ notice: "Device renamed." });
  } catch (error) {
    refreshSavedView({ error: error?.message ?? "That device could not be renamed." });
  }
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

async function onChannelOpen() {
  clearTimer("connectTimer");
  app.animation?.setState("connected");
  setSession({ phase: "connected" });
  try {
    if (app.role === "sender") await onSenderChannelOpen();
    else await onReceiverChannelOpen();
  } catch (error) {
    failTransfer("transfer/failed", { detail: safeDetail(error) });
  }
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

async function onSenderChannelOpen() {
  const identity = await ensureIdentity().catch(() => null);
  const sender = new FileSender({
    transport: app.transport,
    files: app.senderFiles,
    identity,
  });
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

  go("transfer", {
    mode: "send",
    files: app.senderFiles,
    local: identity?.profile ?? null,
    peer: app.peerIdentity ?? app.senderTarget,
  });
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
  markConnectedDeviceSeen();
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
    local: selfIdentity(),
    peer: app.peerIdentity ?? app.senderTarget,
  });
}

async function onReceiverChannelOpen() {
  const identity = await ensureIdentity().catch(() => null);
  const receiver = new FileReceiver({ transport: app.transport });
  app.receiver = receiver;

  // Tell the sender who is receiving as soon as the encrypted channel opens.
  if (identity) {
    try {
      app.transport?.sendControl({ t: CONTROL.HELLO, peer: identity.profile });
    } catch {
      /* the manifest still carries the sender's identity */
    }
  }

  receiver.addEventListener("manifest", (event) => {
    app.animation?.setState("connected");
    app.peerIdentity = event.detail.peer ?? null;
    go("incoming", {
      files: event.detail.files,
      totalBytes: event.detail.totalBytes,
      peer: app.peerIdentity,
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
  markConnectedDeviceSeen();
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
    local: selfIdentity(),
    peer: app.peerIdentity,
  });
}

/** Applies a validated peer profile from the encrypted control channel. */
function acceptPeerIdentity(value) {
  const peer = parseDeviceMetadata(value);
  if (!peer) return null;
  app.peerIdentity = peer;
  app.transferView?.setIdentities?.({ peer });
  return peer;
}

/** @param {Record<string, any>} message */
function onChannelControl(message) {
  if (message.t === CONTROL.HELLO) {
    acceptPeerIdentity(message.peer);
    return;
  }

  // On the receiving side every other control frame belongs to the transfer
  // engine: manifest, file boundaries, completion, cancellation and errors.
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
  app.senderTarget = app.pendingTarget ?? null;
  app.pendingTarget = null;
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
      inviteName: app.senderTarget?.name ?? "",
    });
    addUnloadGuard();
    signaling.connect({ code: room.code, token: room.token });
    if (app.senderTarget) void deliverInvite(app.senderTarget, room.code);
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
        app.pendingTarget = null;
        go("send");
      },
      onReceive: () => go("receive"),
      onNearby: () => go("nearby"),
      onSaved: () => go("saved"),
    }),
  );

  registerRoute("nearby", () => {
    const view = mountNearby({
      onBack: goHome,
      onStart: () => void startNearbyDiscovery(),
      onStop: stopNearbyDiscovery,
      onSend: (peerId) => {
        const peer = app.presence?.peers.find((item) => item.peerId === peerId);
        if (!peer) {
          toast("That device is no longer nearby.", { tone: "danger" });
          return;
        }
        app.pendingTarget = {
          kind: "nearby",
          peerId: peer.peerId,
          deviceId: peer.deviceId,
          name: peer.name,
          deviceType: peer.deviceType,
          platform: peer.platform,
          browser: peer.browser,
          avatar: peer.avatar,
        };
        go("send");
      },
      onAvailableChange: (available) => {
        app.presence?.setAvailable(available);
        view.render({ available });
      },
    });
    app.nearbyView = view;
    const scanning = Boolean(app.presence && !app.presence.stopped);
    view.render({
      phase: scanning ? nearbyPhaseFor(app.presencePhase) : "idle",
      peers: app.presence?.peers ?? [],
      available: app.presence?.available ?? true,
    });
    return view;
  });

  registerRoute("saved", () => {
    const view = mountSavedDevices({
      onBack: goHome,
      onPair: () => go("pair"),
      onSend: (deviceId) => void sendToSavedDevice(deviceId),
      onRemove: (id) => void removeSavedDevice(id),
      onRename: (id, name) => void renameSavedDevice(id, name),
      onReachableChange: (enabled) => void setReachable(enabled),
    });
    app.savedView = view;
    view.render({
      devices: app.savedDeviceCache,
      online: onlineDeviceIds(),
      reachable: Boolean(app.presence && !app.presence.stopped),
      presencePhase: app.presencePhase,
    });
    void loadSavedDevices();
    return view;
  });

  registerRoute("pair", (params) => {
    const view = mountPairing({
      identityPromise: ensureIdentity(),
      initialCode: String(params.code ?? ""),
      onBack: () => go("saved"),
      onSave: async (contact) => {
        await ensureIdentity();
        const saved = await app.savedDevices.save(contact);
        app.savedDeviceCache = await app.savedDevices.list();
        return saved;
      },
    });
    app.pairingView = view;
    return view;
  });

  registerRoute("invite", (params) => {
    const pending = app.pendingInvite ?? {};
    const view = mountInvite({
      name: String(params.name ?? "Unknown device"),
      deviceType: String(params.deviceType ?? ""),
      avatar: String(params.avatar ?? "generic"),
      verified: Boolean(params.verified),
      reason: params.verified ? "Saved device" : "Not saved on this browser",
      onAccept: () => {
        const code = String(params.invite?.code ?? "");
        app.presence?.respondInvite(String(params.fromPeerId ?? ""), true);
        if (!isValidCode(code)) {
          toast("That transfer code is no longer valid.", { tone: "danger" });
          return;
        }
        app.connectedDeviceId = String(params.deviceId ?? "") || null;
        app.pendingInvite = null;
        void joinRoom(code);
      },
      onReject: () => {
        app.presence?.respondInvite(String(params.fromPeerId ?? ""), false);
        app.pendingInvite = null;
        go(params.origin === "saved" ? "saved" : "nearby");
      },
    });
    app.inviteView = view;
    void pending;
    return view;
  });

  registerRoute("profile", () => {
    const view = mountProfile({
      identityPromise: ensureIdentity(),
      onBack: goHome,
      onUpdate: async (patch) => {
        const identity = await ensureIdentity();
        await identity.updateProfile(patch);
        if (app.presence && !app.presence.stopped) {
          await app.presence.refreshIdentity();
        }
        refreshSavedView();
        toast("Device profile updated.", { tone: "success" });
        return identity;
      },
    });
    return view;
  });

  registerRoute("send", (params) => {
    const view = mountFileSelection({
      files: params.files ?? app.senderFiles,
      self: selfIdentity(),
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
      self: selfIdentity(),
      target: app.senderTarget,
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
      peer: params.peer ?? app.peerIdentity,
      onAccept: () => {
        if (!app.receiver || app.receiver.state !== "awaiting-consent") return;
        try {
          app.receiver.accept();
          setSession({ phase: "transferring" });
          app.transferStartedAt = performance.now();
          go("transfer", {
            mode: "receive",
            files: params.files ?? [],
            local: selfIdentity(),
            peer: app.peerIdentity,
          });
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
      local: params.local ?? selfIdentity(),
      peer: params.peer ?? app.peerIdentity,
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
      local: params.local ?? selfIdentity(),
      peer: params.peer ?? app.peerIdentity,
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

  // A pairing QR carries `#pair=CODE`; the code is prefilled, never auto-saved.
  const pairMatch = hash.match(/^#pair=([A-Za-z0-9-]{1,12})$/i);
  if (pairMatch) {
    const pairingCode = normalizePairingCode(pairMatch[1]);
    history.replaceState(null, "", window.location.pathname);
    if (isValidPairingCode(pairingCode)) {
      go("pair", { code: pairingCode });
      return true;
    }
    return false;
  }

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

  for (const trigger of document.querySelectorAll("[data-route]")) {
    trigger.addEventListener("click", () => {
      const route = trigger.dataset.route;
      if (!route) return;
      if (isActive()) {
        toast("Finish or cancel the active transfer first.");
        return;
      }
      go(route);
    });
  }

  // Closing or hiding the tab must never leave a presence record behind.
  window.addEventListener("pagehide", () => app.presence?.stop());

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

  // Every installation gets a profile on first open, not only when a saved
  // device or pairing screen is visited.
  void ensureIdentity().catch((error) => {
    console.warn("[droply] device profile unavailable", error?.message ?? error);
  });

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
