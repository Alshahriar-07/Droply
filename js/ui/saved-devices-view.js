/**
 * Saved Devices screen: paired devices, their reachability and the actions
 * that belong to them (send, rename, remove).
 *
 * "Reachable" is an explicit opt-in: only then does this browser publish a
 * short-lived presence record that lets a paired device send an invite without
 * a code being typed.
 */

import { el, escapeHtml, iconsIn, qs } from "./common.js";
import { deviceAvatarMarkup } from "./device-avatar.js";
import { formatDeviceSubtitle } from "../core/device-profile.js";
import { formatRelativeTime } from "../utils/format-bytes.js";

/**
 * @param {{
 *   onBack: () => void,
 *   onPair: () => void,
 *   onSend: (deviceId: string) => void,
 *   onRemove: (id: string) => void,
 *   onRename: (id: string, name: string) => void,
 *   onReachableChange: (enabled: boolean) => void
 * }} handlers
 */
export function mountSavedDevices({
  onBack,
  onPair,
  onSend,
  onRemove,
  onRename,
  onReachableChange,
}) {
  let devices = [];
  let online = new Set();
  let reachable = false;
  let presencePhase = "idle";
  let editingId = null;

  const element = el(`
    <section class="screen" aria-labelledby="saved-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Back
          </button>
          <span class="pill"><i data-icon="shield-check" data-size="13"></i> Saved</span>
        </div>

        <div class="screen-head screen-head--split">
          <div>
            <h1 id="saved-title">Saved devices</h1>
            <p>Devices you paired once. Send again without reading out a fresh code.</p>
          </div>
          <button type="button" class="btn btn--primary btn--sm" data-pair>
            <i data-icon="plus" data-size="15"></i> Pair a device
          </button>
        </div>

        <div class="card card--padded">
          <label class="switch">
            <input type="checkbox" data-reachable />
            <span class="switch__track" aria-hidden="true"></span>
            <span class="switch__body">
              <span class="switch__title">Make this device reachable</span>
              <span class="switch__hint" data-reachable-hint>
                Publishes a short-lived presence so a saved device can send you an invite without a
                code. Leaving Droply removes it.
              </span>
            </span>
          </label>

          <div class="alert alert--danger alert--rich" data-error role="alert" hidden>
            <i data-icon="circle-alert" data-size="16"></i>
            <span class="alert__body" data-error-text></span>
          </div>

          <div class="alert alert--success" data-notice hidden>
            <i data-icon="circle-check" data-size="16"></i>
            <span data-notice-text></span>
          </div>

          <ul class="saved-list" data-list></ul>

          <div class="nearby-empty" data-empty>
            <p class="nearby-empty__title">No saved devices yet</p>
            <p class="nearby-empty__text">
              Pair two devices by scanning each other's code. Droply stores only the device name,
              its public key and when you last connected.
            </p>
            <button type="button" class="btn btn--secondary btn--sm" data-empty-pair>
              <i data-icon="qr-code" data-size="15"></i> Pair a device
            </button>
          </div>
        </div>

        <p class="stage-note">
          Removing a saved device deletes its public key from this browser. It can never sign an
          invite for you again until you pair it once more.
        </p>
      </div>
    </section>
  `);

  const list = qs(element, "[data-list]");
  const empty = qs(element, "[data-empty]");
  const reachableInput = qs(element, "[data-reachable]");
  const reachableHint = qs(element, "[data-reachable-hint]");
  const errorBox = qs(element, "[data-error]");
  const errorText = qs(element, "[data-error-text]");
  const noticeBox = qs(element, "[data-notice]");
  const noticeText = qs(element, "[data-notice-text]");

  function renderList() {
    list.innerHTML = devices
      .map((device) => {
        const isOnline = online.has(device.deviceId);
        const editing = editingId === device.id;
        return `
          <li class="saved-card" data-id="${escapeHtml(device.id)}">
            ${deviceAvatarMarkup(device.avatar, { size: "md" })}
            <div class="saved-card__body">
              ${
                editing
                  ? `<form class="saved-card__rename" data-rename-form>
                       <input type="text" maxlength="40" value="${escapeHtml(device.name)}"
                         aria-label="Device name" data-rename-input />
                       <button type="submit" class="btn btn--primary btn--sm">Save</button>
                       <button type="button" class="btn btn--ghost btn--sm" data-rename-cancel>Cancel</button>
                     </form>`
                  : `<span class="saved-card__name">${escapeHtml(device.name)}</span>`
              }
              <span class="saved-card__meta">${escapeHtml(
                formatDeviceSubtitle(device) || device.deviceType || "Unknown device",
              )}</span>
              <span class="saved-card__meta">
                Last connected ${formatRelativeTime(device.lastConnectedAt)}
                <span class="saved-card__sep" aria-hidden="true">·</span>
                <span class="saved-card__presence" data-online="${String(isOnline)}">
                  <span class="status-dot ${isOnline ? "status-dot--live" : ""}" aria-hidden="true"></span>
                  ${isOnline ? "Online now" : "Not detected"}
                </span>
              </span>
            </div>
            <div class="saved-card__actions">
              <button type="button" class="btn btn--primary btn--sm" data-send="${escapeHtml(device.deviceId)}">
                <i data-icon="upload" data-size="14"></i> Send files
              </button>
              <button type="button" class="btn btn--ghost btn--sm" data-rename="${escapeHtml(device.id)}"
                aria-label="Rename ${escapeHtml(device.name)}">
                <i data-icon="keyboard" data-size="14"></i>
              </button>
              <button type="button" class="icon-btn icon-btn--danger" data-remove="${escapeHtml(device.id)}"
                aria-label="Remove ${escapeHtml(device.name)}">
                <i data-icon="trash-2" data-size="15"></i>
              </button>
            </div>
          </li>
        `;
      })
      .join("");

    iconsIn(list);
    empty.hidden = devices.length > 0;
    reachableInput.checked = reachable;
    const onlineCount = devices.filter((device) => online.has(device.deviceId)).length;
    reachableHint.textContent = reachable
      ? presencePhase === "online"
        ? "Reachable right now. A saved device can send you an invite."
        : "Turning on reachability…"
      : `${onlineCount} of ${devices.length} saved ${
          devices.length === 1 ? "device is" : "devices are"
        } reachable right now. Turn this on so they can reach you.`;
  }

  /**
   * @param {{
   *   devices?: Array<object>,
   *   online?: string[] | Set<string>,
   *   reachable?: boolean,
   *   presencePhase?: string,
   *   error?: string,
   *   notice?: string
   * }} state
   */
  function render(state = {}) {
    if (Array.isArray(state.devices)) devices = state.devices;
    if (state.online) online = new Set([...state.online]);
    if (typeof state.reachable === "boolean") reachable = state.reachable;
    if (typeof state.presencePhase === "string") presencePhase = state.presencePhase;

    if (state.error) {
      errorText.textContent = String(state.error);
      errorBox.hidden = false;
    } else {
      errorBox.hidden = true;
    }
    if (state.notice) {
      noticeText.textContent = String(state.notice);
      noticeBox.hidden = false;
    } else {
      noticeBox.hidden = true;
    }
    renderList();
  }

  list.addEventListener("click", (event) => {
    const send = event.target.closest("[data-send]");
    if (send) {
      onSend(send.dataset.send);
      return;
    }
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      onRemove(remove.dataset.remove);
      return;
    }
    const rename = event.target.closest("[data-rename]");
    if (rename) {
      editingId = rename.dataset.rename;
      renderList();
      const input = list.querySelector("[data-rename-input]");
      input?.focus();
      input?.select();
      return;
    }
    if (event.target.closest("[data-rename-cancel]")) {
      editingId = null;
      renderList();
    }
  });

  list.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-rename-form]");
    if (!form) return;
    event.preventDefault();
    const id = form.closest("[data-id]")?.dataset.id;
    const input = form.querySelector("[data-rename-input]");
    const name = (input?.value ?? "").trim();
    if (!id || !name) return;
    editingId = null;
    onRename(id, name);
  });

  reachableInput.addEventListener("change", () => onReachableChange(reachableInput.checked));
  qs(element, "[data-pair]").addEventListener("click", onPair);
  qs(element, "[data-empty-pair]").addEventListener("click", onPair);
  qs(element, "[data-back]").addEventListener("click", onBack);

  render({});

  return {
    element,
    title: "Saved devices",
    render,
    dispose() {
      /* no timers */
    },
  };
}
