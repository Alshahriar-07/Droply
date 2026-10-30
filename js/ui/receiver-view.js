/** Receiver screens: choice, code entry and incoming-transfer consent. */

import { el, escapeHtml, fileRowMarkup, iconsIn, qs } from "./common.js";
import { deviceAvatarMarkup } from "./device-avatar.js";
import { formatDeviceSubtitle } from "../core/device-profile.js";
import { formatBytes, formatFileCount } from "../utils/format-bytes.js";
import { extractRoomCode, isValidCode, normalizeCode } from "../utils/validation.js";
import { describeError } from "../core/errors.js";

/* --------------------------------------------------------------------------
   Screen 4 — scan or enter a code
   -------------------------------------------------------------------------- */

/**
 * @param {{ onScan: () => void, onCode: () => void, onBack: () => void }} options
 */
export function mountReceiveChoice({ onScan, onCode, onBack }) {
  const element = el(`
    <section class="screen" aria-labelledby="receive-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Back
          </button>
          <span class="pill">Receive</span>
        </div>

        <div class="screen-head">
          <h1 id="receive-title">How do you want to connect?</h1>
          <p>Scan the QR code shown on the sending device, or type the six-character code.</p>
        </div>

        <div class="choice-grid">
          <button type="button" class="choice" data-scan>
            <span class="choice__icon"><i data-icon="qr-code" data-size="22"></i></span>
            <span class="choice__body">
              <span class="choice__title">Scan QR</span>
              <span class="choice__desc">Use your camera to scan the sender's code.</span>
            </span>
          </button>

          <button type="button" class="choice" data-code>
            <span class="choice__icon"><i data-icon="keyboard" data-size="22"></i></span>
            <span class="choice__body">
              <span class="choice__title">Enter code</span>
              <span class="choice__desc">Type the six characters shown on the other device.</span>
            </span>
          </button>
        </div>

        <p class="panel__hint" style="text-align: center">
          Camera access is only requested when you choose Scan QR.
        </p>
      </div>
    </section>
  `);

  qs(element, "[data-back]").addEventListener("click", onBack);
  qs(element, "[data-scan]").addEventListener("click", onScan);
  qs(element, "[data-code]").addEventListener("click", onCode);

  return { element, title: "Receive files" };
}

/* --------------------------------------------------------------------------
   Screen 5 — six-character code entry
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   initialCode?: string,
 *   onBack: () => void,
 *   onSubmit: (code: string) => void,
 *   onScanInstead: () => void
 * }} options
 */
export function mountCodeEntry({ initialCode = "", onBack, onSubmit, onScanInstead }) {
  let busy = false;

  const element = el(`
    <section class="screen" aria-labelledby="code-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Back
          </button>
          <span class="pill">Step 1 of 2</span>
        </div>

        <div class="screen-head">
          <h1 id="code-title">Enter the transfer code</h1>
          <p>Six characters from the sending device. Codes are not case-sensitive.</p>
        </div>

        <form class="card code-panel" data-form novalidate>
          <div class="code-slots" data-slots>
            <span class="code-slot" data-slot="0"></span>
            <span class="code-slot" data-slot="1"></span>
            <span class="code-slot" data-slot="2"></span>
            <span class="code-slot" data-slot="3"></span>
            <span class="code-slot" data-slot="4"></span>
            <span class="code-slot" data-slot="5"></span>
            <input
              class="code-slots__input"
              data-input
              type="text"
              inputmode="text"
              autocomplete="one-time-code"
              autocapitalize="characters"
              autocorrect="off"
              spellcheck="false"
              maxlength="6"
              aria-label="Six-character transfer code"
            />
          </div>

          <div class="code-help">
            <span>Paste a code or invite link — no O, 0, I or 1 in codes.</span>
            <span class="tabular" data-length>0 / 6</span>
          </div>

          <div class="alert alert--danger alert--rich" data-error role="alert" hidden>
            <i data-icon="circle-alert" data-size="16"></i>
            <span class="alert__body" data-error-text></span>
          </div>

          <button type="submit" class="btn btn--primary btn--lg btn--block" data-submit disabled>
            <span data-submit-label>Connect</span>
          </button>
          <button type="button" class="btn btn--ghost btn--sm btn--block" data-scan>
            <i data-icon="qr-code" data-size="15"></i> Scan a QR code instead
          </button>
        </form>
      </div>
    </section>
  `);

  const input = qs(element, "[data-input]");
  const form = qs(element, "[data-form]");
  const submitBtn = qs(element, "[data-submit]");
  const lengthLabel = qs(element, "[data-length]");
  const slots = Array.from(element.querySelectorAll("[data-slot]"));
  const errorBox = qs(element, "[data-error]");
  const errorText = qs(element, "[data-error-text]");

  input.value = normalizeCode(initialCode);

  function render() {
    const value = input.value;
    const activeIndex = Math.min(value.length, slots.length - 1);
    const focused = document.activeElement === input;

    slots.forEach((slot, index) => {
      const char = value[index] ?? "";
      slot.textContent = char;
      slot.dataset.filled = String(Boolean(char));
      slot.dataset.active = String(index === activeIndex);
      slot.dataset.caret = String(index === value.length && focused && value.length < 6);
    });

    lengthLabel.textContent = `${value.length} / 6`;
    submitBtn.disabled = busy || value.length !== 6;
  }

  function setBusy(next) {
    busy = next;
    input.disabled = next;
    submitBtn.disabled = next || input.value.length !== 6;
    submitBtn.innerHTML = next
      ? `<span class="spinner" aria-hidden="true"></span><span>Connecting…</span>`
      : `<span data-submit-label>Connect</span>`;
    render();
  }

  /** Inline failure copy always comes from the central catalog. */
  function showError(errorId) {
    const spec = describeError(errorId);
    errorText.innerHTML = `
      <strong>${escapeHtml(spec.title)}</strong>
      <span>${escapeHtml(spec.message)}</span>
    `;
    errorBox.hidden = false;
    errorBox.setAttribute("data-error-id", errorId);
    setBusy(false);
    input.focus();
    input.select();
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.removeAttribute("data-error-id");
    errorText.textContent = "";
  }

  input.addEventListener("input", () => {
    const normalized = normalizeCode(input.value);
    if (input.value !== normalized) input.value = normalized;
    clearError();
    render();
  });

  input.addEventListener("focus", render);
  input.addEventListener("blur", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text") ?? "";
    // A pasted invite link carries the code after #/receive; accept both.
    input.value = normalizeCode(extractRoomCode(text) || text);
    clearError();
    render();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    const code = normalizeCode(input.value);
    if (!isValidCode(code)) {
      showError("code/incomplete");
      return;
    }
    clearError();
    setBusy(true);
    onSubmit(code);
  });

  qs(element, "[data-back]").addEventListener("click", () => {
    if (!busy) onBack();
  });
  qs(element, "[data-scan]").addEventListener("click", () => {
    if (!busy) onScanInstead();
  });

  render();
  window.setTimeout(() => input.focus({ preventScroll: true }), 220);

  return {
    element,
    title: "Enter code",
    showError,
    setBusy,
    getCode: () => normalizeCode(input.value),
    setCode(value) {
      input.value = normalizeCode(value);
      render();
    },
  };
}

/* --------------------------------------------------------------------------
   Screen 7 — incoming transfer consent
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   files: Array<{ name: string, size: number, type: string, id?: string }>,
 *   totalBytes: number,
 *   peer?: object|null,
 *   onAccept: () => void,
 *   onReject: () => void
 * }} options
 */
export function mountIncomingTransfer({ files, totalBytes, peer = null, onAccept, onReject }) {
  let busy = false;

  const listMarkup = files.map((file) => fileRowMarkup(file, { id: file.id })).join("");
  const canFit = files.length <= 200;

  const element = el(`
    <section class="screen" aria-labelledby="incoming-title">
      <div class="stage stage--narrow">
        <div class="screen-head screen-head--center">
          <span class="pill pill--blue">
            <span class="status-dot status-dot--live" aria-hidden="true"></span> Connected
          </span>
          <h1 id="incoming-title">A device wants to send you files</h1>
          <p>Review the files first. Nothing is transferred until you accept.</p>
        </div>

        <div class="card consent">
          <div class="consent__head">
            ${deviceAvatarMarkup(peer?.avatar, { size: "lg" })}
            <div>
              <div class="consent__title" data-peer-name></div>
              <div class="consent__sub" data-sub></div>
            </div>
          </div>

          <div class="consent__files">
            <ul class="file-list">${listMarkup}</ul>
          </div>

          <div class="consent__totals">
            <span><strong data-count></strong></span>
            <span><strong data-total-size></strong></span>
          </div>

          ${
            canFit
              ? ""
              : `<div class="alert alert--danger"><i data-icon="circle-alert" data-size="16"></i>
                  <span>This transfer has too many files for this browser.</span></div>`
          }

          <div class="btn-group btn-group--end">
            <button type="button" class="btn btn--secondary" data-reject>Decline</button>
            <button type="button" class="btn btn--blue btn--lg" data-accept>
              <i data-icon="download" data-size="17"></i> Accept transfer
            </button>
          </div>
        </div>

        <p class="panel__hint" style="text-align: center">
          Files are kept in this browser tab only. Save them before closing the tab.
        </p>
      </div>
    </section>
  `);

  qs(element, "[data-count]").textContent = formatFileCount(files.length);
  qs(element, "[data-total-size]").textContent = formatBytes(totalBytes);
  const peerName = String(peer?.name ?? "").trim();
  const peerDetail = formatDeviceSubtitle(peer ?? {});
  qs(element, "[data-peer-name]").textContent = peerName
    ? `Incoming files from ${peerName}`
    : "Incoming transfer";
  qs(element, "[data-sub]").textContent = [peerDetail, formatFileCount(files.length), formatBytes(totalBytes)]
    .filter(Boolean)
    .join(" · ");
  iconsIn(element);

  const acceptBtn = qs(element, "[data-accept]");
  const rejectBtn = qs(element, "[data-reject]");

  acceptBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    acceptBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Starting…</span>`;
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    onAccept();
  });

  rejectBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    onReject();
  });

  return { element, title: "Incoming transfer" };
}
