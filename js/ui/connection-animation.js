/**
 * The device-to-device connection visual. It is purely presentational: every
 * state change must be driven by real WebRTC/signaling events from app.js.
 */

import { el, qs } from "./common.js";

const STATES = {
  idle: {
    label: "Getting ready",
    detail: "Opening a private channel between the two devices.",
    wire: 0,
    step: -1,
  },
  waiting: {
    label: "Waiting for the other device",
    detail: "Share the code or QR code. No file data moves until they join.",
    wire: 0,
    step: 0,
  },
  joining: {
    label: "Connecting to your device",
    detail: "The other browser is joining this transfer.",
    wire: 0.18,
    step: 0,
  },
  negotiating: {
    label: "Setting up a private link",
    detail: "The two browsers are agreeing on an encrypted connection.",
    wire: 0.42,
    step: 1,
  },
  connecting: {
    label: "Connecting to your device",
    detail: "Finding the fastest path between the two browsers.",
    wire: 0.68,
    step: 1,
  },
  connected: {
    label: "Connected",
    detail: "The private channel is open. Nothing has been sent yet.",
    wire: 1,
    step: 2,
  },
  "waiting-accept": {
    label: "Waiting for approval",
    detail: "The other device is reviewing the files. Nothing moves until they accept.",
    wire: 1,
    step: 2,
  },
  transferring: {
    label: "Transferring",
    detail: "Files are moving directly between the two devices.",
    wire: 1,
    step: 3,
  },
  completed: {
    label: "Transfer complete",
    detail: "Closing the connection and releasing the room.",
    wire: 1,
    step: 3,
  },
  failed: {
    label: "Couldn't connect",
    detail: "The two devices couldn't find a route to each other.",
    wire: 0.5,
    step: 1,
  },
  cancelled: {
    label: "Transfer cancelled",
    detail: "The room is closed and no files were transferred.",
    wire: 0,
    step: -1,
  },
  reconnecting: {
    label: "Reconnecting",
    detail: "The connection dropped. Trying again…",
    wire: 0.5,
    step: 1,
  },
};

const STEP_LABELS = ["Device found", "Secure link", "Connected", "Transferring"];

const DEVICE_ICONS = {
  sender: "monitor",
  receiver: "smartphone",
};

export class ConnectionAnimation {
  /**
   * @param {{ role: "sender"|"receiver", state?: string }} options
   */
  constructor({ role, state = "idle" }) {
    this.role = role;
    this.state = state;

    this.element = el(`
      <div class="connection-visual">
        <div
          class="link-visual"
          data-state="${state}"
          data-role="${role}"
          data-receiver="${role === "receiver" ? "present" : "absent"}"
        >
          <div class="device device--sender">
            <div class="device__frame"><i data-icon="${DEVICE_ICONS.sender}" data-size="24"></i></div>
            <span class="device__label">${role === "sender" ? "This device" : "Sender"}</span>
          </div>
          <div class="bridge">
            <div class="bridge__wire"></div>
            <div class="bridge__packets">
              <span class="packet" style="--delay:0s"></span>
              <span class="packet" style="--delay:0.53s"></span>
              <span class="packet" style="--delay:1.06s"></span>
            </div>
          </div>
          <div class="device device--receiver">
            <div class="device__frame"><i data-icon="${DEVICE_ICONS.receiver}" data-size="24"></i></div>
            <span class="device__label">${role === "receiver" ? "This device" : "Receiver"}</span>
          </div>
        </div>
        <div class="link-status" role="status" aria-live="polite">
          <span class="link-status__label">
            <span class="spinner" data-spinner aria-hidden="true" hidden></span>
            <span data-label></span>
          </span>
          <span class="link-status__detail" data-detail></span>
        </div>
        <div class="steps-track" aria-hidden="true">
          ${STEP_LABELS.map(
            (label, index) =>
              `<span class="steps-track__item" data-step="${index}">${label}</span>`,
          ).join("")}
        </div>
      </div>
    `);

    this.visual = qs(this.element, ".link-visual");
    this.labelNode = qs(this.element, "[data-label]");
    this.detailNode = qs(this.element, "[data-detail]");
    this.spinner = qs(this.element, "[data-spinner]");

    this.setState(state);
  }

  /** Shows/hides the far-side device indicator. */
  setReceiverPresent(present) {
    if (this.visual) this.visual.dataset.receiver = present ? "present" : "absent";
  }

  setDetail(text) {
    if (this.detailNode) this.detailNode.textContent = text;
  }

  /**
   * @param {keyof typeof STATES} state
   * @param {string} [detailOverride]
   */
  setState(state, detailOverride) {
    const preset = STATES[state] ?? STATES.idle;
    this.state = state;
    if (this.visual) {
      this.visual.dataset.state = state;
      this.visual.style.setProperty("--wire-progress", String(preset.wire));
    }
    if (this.labelNode) this.labelNode.textContent = preset.label;
    this.setDetail(detailOverride ?? preset.detail);

    const busy = ["waiting", "joining", "negotiating", "connecting", "reconnecting"].includes(
      state,
    );
    if (this.spinner) this.spinner.hidden = !busy;

    for (const item of this.element.querySelectorAll(".steps-track__item")) {
      const index = Number(item.dataset.step);
      item.dataset.done = String(index < preset.step || state === "completed");
      item.dataset.active = String(index === preset.step && state !== "completed");
    }
  }

  destroy() {
    this.element.remove();
  }
}
