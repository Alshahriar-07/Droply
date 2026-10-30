/**
 * Nearby Devices screen.
 *
 * Presentational only: the controller owns the presence connection and pushes
 * a state object in. Every status shown here is derived from a real presence
 * event, never from a timer or a mock list.
 */

import { el, escapeHtml, iconsIn, qs } from "./common.js";
import { deviceAvatarMarkup } from "./device-avatar.js";
import { formatDeviceSubtitle } from "../core/device-profile.js";

const PHASES = {
  idle: {
    label: "Not scanning",
    detail: "Turn on discovery to see Droply devices on this network.",
    tone: "idle",
  },
  starting: {
    label: "Starting discovery",
    detail: "Registering this device with the nearby service…",
    tone: "busy",
  },
  scanning: {
    label: "Scanning for devices",
    detail: "Looking for Droply devices that opted in on this network.",
    tone: "busy",
  },
  online: {
    label: "Discovering",
    detail: "Discovery is on. Other devices appear as soon as they opt in.",
    tone: "live",
  },
  reconnecting: {
    label: "Reconnecting",
    detail: "The nearby channel dropped. Trying again…",
    tone: "busy",
  },
  offline: {
    label: "Discovery stopped",
    detail: "This device is no longer listed. Start again to keep discovering.",
    tone: "idle",
  },
};

/**
 * @param {{
 *   onBack: () => void,
 *   onStart: () => void,
 *   onStop: () => void,
 *   onSend: (peerId: string) => void,
 *   onAvailableChange: (available: boolean) => void
 * }} handlers
 */
export function mountNearby({ onBack, onStart, onStop, onSend, onAvailableChange }) {
  let selectedPeerId = null;
  let currentPeers = [];
  let currentPhase = "idle";
  let available = true;

  const element = el(`
    <section class="screen" aria-labelledby="nearby-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Back
          </button>
          <span class="pill"><i data-icon="wifi" data-size="13"></i> Nearby</span>
        </div>

        <div class="screen-head">
          <h1 id="nearby-title">Nearby devices</h1>
          <p>
            Discover Droply on this network and start a transfer without reading a code out loud.
            Discovery is off until you turn it on.
          </p>
        </div>

        <div class="card card--padded nearby-panel">
          <div class="nearby-status" data-status data-tone="idle">
            <span class="scan-orb" aria-hidden="true">
              <span class="scan-orb__ring"></span>
              <span class="scan-orb__ring"></span>
              <span class="scan-orb__ring"></span>
              <span class="scan-orb__core"><i data-icon="wifi" data-size="18"></i></span>
            </span>
            <div class="nearby-status__body">
              <span class="nearby-status__label" data-status-label>Not scanning</span>
              <span class="nearby-status__detail" data-status-detail>
                Turn on discovery to see Droply devices on this network.
              </span>
            </div>
            <div class="btn-group" data-controls>
              <button type="button" class="btn btn--primary btn--sm" data-start>
                <i data-icon="scan-line" data-size="15"></i> Start discovery
              </button>
              <button type="button" class="btn btn--secondary btn--sm" data-stop hidden>
                <i data-icon="ban" data-size="15"></i> Stop
              </button>
            </div>
          </div>

          <label class="switch" data-available-row hidden>
            <input type="checkbox" data-available checked />
            <span class="switch__track" aria-hidden="true"></span>
            <span class="switch__body">
              <span class="switch__title">Available for transfers</span>
              <span class="switch__hint">Turn this off to stay listed but not receive invites.</span>
            </span>
          </label>

          <div class="alert alert--danger alert--rich" data-error role="alert" hidden>
            <i data-icon="circle-alert" data-size="16"></i>
            <span class="alert__body" data-error-text></span>
          </div>

          <div class="device-list-head">
            <span class="code-label">On this network</span>
            <span class="device-list-count tabular" data-count>0 devices</span>
          </div>

          <ul class="device-list" data-list aria-live="polite"></ul>

          <div class="nearby-empty" data-empty>
            <p class="nearby-empty__title">No devices yet</p>
            <p class="nearby-empty__text">
              Open Droply on the other device, choose <strong>Nearby Devices</strong>, and start
              discovery there too. Both devices must be on the same network.
            </p>
          </div>
        </div>

        <div class="nearby-action" data-action hidden>
          <div class="nearby-action__body">
            <span class="nearby-action__label">Selected device</span>
            <span class="nearby-action__name" data-selected-name></span>
          </div>
          <button type="button" class="btn btn--primary" data-send>
            <i data-icon="upload" data-size="16"></i> Send files
          </button>
        </div>

        <p class="stage-note">
          Browsers can't scan Wi-Fi directly. Droply only lists devices that opted in and share this
          network's public address — a device on a different network can't appear here.
        </p>
      </div>
    </section>
  `);

  const statusRow = qs(element, "[data-status]");
  const statusLabel = qs(element, "[data-status-label]");
  const statusDetail = qs(element, "[data-status-detail]");
  const startBtn = qs(element, "[data-start]");
  const stopBtn = qs(element, "[data-stop]");
  const availableRow = qs(element, "[data-available-row]");
  const availableInput = qs(element, "[data-available]");
  const errorBox = qs(element, "[data-error]");
  const errorText = qs(element, "[data-error-text]");
  const list = qs(element, "[data-list]");
  const empty = qs(element, "[data-empty]");
  const count = qs(element, "[data-count]");
  const action = qs(element, "[data-action]");
  const selectedName = qs(element, "[data-selected-name]");
  const sendBtn = qs(element, "[data-send]");

  function selectedPeer() {
    return currentPeers.find((peer) => peer.peerId === selectedPeerId) ?? null;
  }

  function renderList() {
    const peer = selectedPeer();
    if (peer) selectedName.textContent = peer.name;

    list.innerHTML = currentPeers
      .map((device) => {
        const online = device.available;
        const subtitle = formatDeviceSubtitle(device) || device.deviceType || "Droply device";
        return `
          <li>
            <button type="button" class="device-card" data-peer="${escapeHtml(device.peerId)}"
              aria-pressed="${String(device.peerId === selectedPeerId)}"
              data-selected="${String(device.peerId === selectedPeerId)}">
              ${deviceAvatarMarkup(device.avatar, { size: "sm" })}
              <span class="device-card__body">
                <span class="device-card__name">${escapeHtml(device.name)}</span>
                <span class="device-card__meta">${escapeHtml(subtitle)}</span>
              </span>
              <span class="device-card__status">
                <span class="status-dot ${online ? "status-dot--live" : ""}" aria-hidden="true"></span>
                ${online ? "Available" : "Busy"}
              </span>
            </button>
          </li>
        `;
      })
      .join("");

    iconsIn(list);
    empty.hidden = currentPeers.length > 0;
    count.textContent = `${currentPeers.length} ${currentPeers.length === 1 ? "device" : "devices"}`;
    action.hidden = !peer;
    sendBtn.disabled = !peer || !peer.available;
    sendBtn.title = peer && !peer.available ? "That device is busy right now." : "";
  }

  /**
   * @param {{
   *   phase: string,
   *   peers?: Array<{peerId: string, name: string, deviceType?: string, available?: boolean}>,
   *   error?: string,
   *   notice?: string,
   *   available?: boolean
   * }} state
   */
  function render(state = {}) {
    currentPhase = state.phase ?? currentPhase;
    if (Array.isArray(state.peers)) currentPeers = state.peers;
    if (typeof state.available === "boolean") available = state.available;
    if (typeof state.notice === "string" && state.notice) {
      errorBox.hidden = true;
    }

    const preset = PHASES[currentPhase] ?? PHASES.idle;
    statusRow.dataset.tone = preset.tone;
    statusLabel.textContent = state.notice || preset.label;
    statusDetail.textContent = preset.detail;

    const scanning = ["starting", "scanning", "online", "reconnecting"].includes(currentPhase);
    startBtn.hidden = scanning;
    stopBtn.hidden = !scanning;
    availableRow.hidden = !scanning;
    availableInput.checked = available;

    if (state.error) {
      errorText.textContent = String(state.error);
      errorBox.hidden = false;
    } else if (!state.notice) {
      errorBox.hidden = true;
    }

    if (selectedPeerId && !currentPeers.some((peer) => peer.peerId === selectedPeerId)) {
      selectedPeerId = null;
    }
    renderList();
  }

  list.addEventListener("click", (event) => {
    const card = event.target.closest("[data-peer]");
    if (!card) return;
    const peerId = card.dataset.peer;
    selectedPeerId = selectedPeerId === peerId ? null : peerId;
    renderList();
  });

  qs(element, "[data-back]").addEventListener("click", onBack);
  startBtn.addEventListener("click", onStart);
  stopBtn.addEventListener("click", onStop);
  availableInput.addEventListener("change", () => onAvailableChange(availableInput.checked));
  sendBtn.addEventListener("click", () => {
    const peer = selectedPeer();
    if (peer) onSend(peer.peerId);
  });

  render({ phase: "idle", peers: [] });

  return {
    element,
    title: "Nearby devices",
    render,
    getSelectedPeer: () => selectedPeer(),
    dispose() {
      /* no timers or streams of its own */
    },
  };
}
