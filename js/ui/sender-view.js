/** Sender screens: file selection and the waiting room. */

import { ConnectionAnimation } from "./connection-animation.js";
import {
  copyText,
  el,
  escapeHtml,
  fileRowMarkup,
  iconsIn,
  qs,
  toast,
} from "./common.js";
import { config } from "../config.js";
import { formatBytes, formatCountdown, formatFileCount } from "../utils/format-bytes.js";
import { assertLocalFilesAreSendable, displayCode } from "../utils/validation.js";
import { describeError } from "../core/errors.js";
import { identityMarkup } from "./device-avatar.js";

/* --------------------------------------------------------------------------
   Screen 2 — choose files
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   files?: File[],
 *   self?: object|null,
 *   onBack: () => void,
 *   onCreate: (files: File[]) => void
 * }} options
 */
export function mountFileSelection({ files = [], self = null, onBack, onCreate }) {
  let selected = [...files];
  let busy = false;

  const element = el(`
    <section class="screen screen--narrow" aria-labelledby="send-title">
      <div class="back-row">
        <button type="button" class="btn btn--ghost btn--sm" data-back>
          <i data-icon="arrow-left" data-size="16"></i> Back
        </button>
        <span class="pill">Step 1 of 2</span>
      </div>

      <div class="screen-head">
        <h1 id="send-title">Choose files to send</h1>
        <p>Add one or more files. They stay on your device until the receiver accepts the transfer.</p>
      </div>

      <div class="identity-strip" data-sender-identity>
        <div class="identity-strip__side">
          <div>
            <span class="identity-strip__label">Sending from</span>
            ${identityMarkup(self, { size: "sm", fallback: "This device" })}
          </div>
        </div>
      </div>

      <div class="card card--padded panel">
        <input type="file" id="file-input" data-file-input multiple hidden />

        <div
          class="dropzone"
          data-dropzone
          role="button"
          tabindex="0"
          aria-controls="file-input"
          aria-label="Add files to send"
        >
          <span class="dropzone__icon"><i data-icon="upload" data-size="24"></i></span>
          <p class="dropzone__title">Drop files here</p>
          <p class="dropzone__hint">
            or <span class="dropzone__browse">choose from your device</span><br />
            Any file type · up to ${formatBytes(config.maxTotalBytes, { decimals: 0 })} per file
          </p>
        </div>

        <div data-selection hidden>
          <div class="panel__head">
            <h2 class="panel__title">Selected files</h2>
            <div class="btn-group">
              <button type="button" class="btn btn--ghost btn--sm" data-add-more>
                <i data-icon="plus" data-size="15"></i> Add files
              </button>
              <button type="button" class="btn btn--ghost btn--sm" data-clear-all>Clear</button>
            </div>
          </div>
          <ul class="file-list" data-file-list></ul>
          <div class="limit-meter" data-meter data-over="false">
            <div class="limit-meter__head">
              <span class="code-label">Transfer size</span>
              <span class="limit-meter__value tabular">
                <strong data-total-size>0 B</strong> of <span data-limit></span>
              </span>
            </div>
            <div
              class="limit-meter__track"
              data-meter-track
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="0"
              aria-label="Selected files against the transfer limit"
            >
              <span class="limit-meter__fill" data-meter-fill></span>
            </div>
            <div class="limit-meter__foot">
              <span data-total-count>0 files</span>
              <span data-remaining></span>
            </div>
          </div>
        </div>

        <div class="alert alert--danger alert--rich" data-error role="alert" hidden>
          <i data-icon="circle-alert" data-size="16"></i>
          <span class="alert__body" data-error-text></span>
        </div>

        <button type="button" class="btn btn--primary btn--lg btn--block" data-create disabled>
          <span data-create-label>Create transfer</span>
        </button>
        <p class="panel__hint" style="text-align: center">
          A one-time room is created. Nothing is uploaded to Droply.
        </p>
      </div>
    </section>
  `);

  const input = qs(element, "[data-file-input]");
  const dropzone = qs(element, "[data-dropzone]");
  const list = qs(element, "[data-file-list]");
  const selection = qs(element, "[data-selection]");
  const createBtn = qs(element, "[data-create]");
  const errorBox = qs(element, "[data-error]");
  const errorText = qs(element, "[data-error-text]");
  const totalSize = qs(element, "[data-total-size]");
  const totalCount = qs(element, "[data-total-count]");
  const remaining = qs(element, "[data-remaining]");
  const limitNode = qs(element, "[data-limit]");
  const meter = qs(element, "[data-meter]");
  const meterFill = qs(element, "[data-meter-fill]");
  const meterTrack = qs(element, "[data-meter-track]");

  const fileKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;

  /**
   * @param {{ code?: string, message?: string } | string} failure A catalog id
   *   (preferred) or a plain sentence when no catalog entry applies.
   */
  function showError(failure) {
    const id = typeof failure === "string" ? null : failure?.code ?? null;
    if (id) {
      const spec = describeError(id);
      errorText.innerHTML = `<strong>${escapeHtml(spec.title)}</strong><span>${escapeHtml(
        spec.message,
      )}</span>`;
    } else {
      errorText.textContent =
        typeof failure === "string" ? failure : String(failure?.message ?? "");
    }
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorText.textContent = "";
  }

  function render() {
    const hasFiles = selected.length > 0;
    selection.hidden = !hasFiles;
    createBtn.disabled = !hasFiles || busy;

    list.innerHTML = selected
      .map((file, index) =>
        fileRowMarkup(file, {
          id: String(index),
          action: `
            <button type="button" class="icon-btn icon-btn--danger" data-remove="${index}"
              aria-label="Remove ${escapeHtml(file.name)}">
              <i data-icon="trash-2" data-size="16"></i>
            </button>`,
        }),
      )
      .join("");
    iconsIn(list);

    const bytes = selected.reduce((sum, file) => sum + file.size, 0);
    totalSize.textContent = formatBytes(bytes);
    totalCount.textContent = formatFileCount(selected.length);
    const limit = formatBytes(config.maxTotalBytes, { decimals: 0 });
    const left = config.maxTotalBytes - bytes;
    remaining.textContent =
      left >= 0
        ? `${remainingLabel(left)} of ${limit} left`
        : `${formatBytes(-left)} over the ${limit} limit`;

    // The meter is cumulative selection size against the same ceiling the
    // validator enforces, so it can never disagree with a rejection.
    limitNode.textContent = limit;
    const usage = Math.min(1, bytes / config.maxTotalBytes);
    meterFill.style.setProperty("--usage", String(usage));
    meter.dataset.over = String(bytes > config.maxTotalBytes);
    meterTrack.setAttribute("aria-valuenow", String(Math.round(usage * 100)));
  }

  /** Rounds gigabytes down so "4.9 GB left" never reads as a full "5 GB". */
  function remainingLabel(bytes) {
    const gib = 1024 ** 3;
    if (bytes < gib) return formatBytes(bytes);
    return `${(Math.floor((bytes / gib) * 10) / 10).toFixed(1)} GB`;
  }

  function addFiles(fileList) {
    if (busy) return;
    let added = 0;
    const existing = new Set(selected.map(fileKey));
    for (const file of Array.from(fileList ?? [])) {
      const key = fileKey(file);
      if (existing.has(key)) continue;
      existing.add(key);
      selected.push(file);
      added += 1;
    }
    if (!added) {
      if (fileList?.length) toast("Those files are already in the list.");
      return;
    }
    // Reject an oversized selection immediately instead of waiting for the
    // create button, so the limit is obvious while picking files.
    const before = selected.slice(0, selected.length - added);
    try {
      assertLocalFilesAreSendable(selected);
    } catch (error) {
      selected = before;
      clearError();
      render();
      showError(error);
      return;
    }
    clearError();
    render();
    if (added > 1) toast(`Added ${formatFileCount(added)}.`, { tone: "success" });
  }

  function openPicker() {
    if (!busy) input.click();
  }

  function setBusy(next) {
    busy = next;
    createBtn.disabled = !selected.length || busy;
    dropzone.setAttribute("aria-disabled", String(busy));
    createBtn.innerHTML = busy
      ? `<span class="spinner" aria-hidden="true"></span><span>Creating secure room…</span>`
      : `<span data-create-label>Create transfer</span>`;
  }

  qs(element, "[data-back]").addEventListener("click", () => {
    if (!busy) onBack();
  });

  dropzone.addEventListener("click", openPicker);
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  });

  qs(element, "[data-add-more]").addEventListener("click", openPicker);

  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });

  qs(element, "[data-clear-all]").addEventListener("click", () => {
    if (busy) return;
    selected = [];
    clearError();
    render();
  });

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button || busy) return;
    selected.splice(Number(button.dataset.remove), 1);
    clearError();
    render();
  });

  /* Drag and drop */
  let dragDepth = 0;
  const setDragging = (value) => {
    dropzone.dataset.dragging = String(value);
  };

  dropzone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    if (!busy) setDragging(true);
  });
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  dropzone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  });
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  });

  createBtn.addEventListener("click", () => {
    if (busy) return;
    clearError();
    try {
      assertLocalFilesAreSendable(selected);
    } catch (error) {
      showError(error);
      return;
    }
    setBusy(true);
    onCreate([...selected]);
  });

  render();

  return {
    element,
    title: "Choose files",
    /** Surfaces a controller-side failure (e.g. signaling unavailable). */
    showError: (failure) => {
      setBusy(false);
      showError(failure);
    },
    setBusy,
    getFiles: () => [...selected],
  };
}

/* --------------------------------------------------------------------------
   Screen 3 — waiting room with code + QR
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   code: string,
 *   receiveUrl: string,
 *   expiresAt: string|null,
 *   onCancel: () => void,
 *   inviteName?: string,
 *   self?: object|null,
 *   target?: object|null
 * }} options
 */
export function mountSenderWaiting({
  code,
  receiveUrl,
  expiresAt,
  onCancel,
  inviteName = "",
  self = null,
  target = null,
}) {
  const animation = new ConnectionAnimation({ role: "sender", state: "waiting" });

  const element = el(`
    <section class="screen" aria-labelledby="waiting-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Cancel
          </button>
          <span class="pill" data-expiry>
            <i data-icon="clock" data-size="13"></i>
            <span data-expiry-text>Room open</span>
          </span>
        </div>

        <div class="screen-head">
          <h1 id="waiting-title">Share this code</h1>
          <p>The other device enters these six characters or scans the QR code to connect.</p>
        </div>

        <div class="identity-strip" data-waiting-identities>
          <div class="identity-strip__side">
            <div>
              <span class="identity-strip__label">Sending from</span>
              ${identityMarkup(self, { size: "sm", fallback: "This device" })}
            </div>
          </div>
          <span class="identity-strip__arrow" aria-hidden="true">→</span>
          <div class="identity-strip__side">
            <div>
              <span class="identity-strip__label">Sending to</span>
              ${
                target
                  ? identityMarkup(target, { size: "sm" })
                  : `<span class="device-identity__meta">Whoever enters the code</span>`
              }
            </div>
          </div>
        </div>

        <div class="card pairing">
          <div class="pairing__main">
            <div>
              <div class="code-label">Transfer code</div>
              <div class="code-display">
                <span class="code-display__value" data-code>${escapeHtml(displayCode(code))}</span>
                <button type="button" class="copy-btn" data-copy>
                  <i data-icon="copy" data-size="14"></i>
                  <span data-copy-label>Copy</span>
                </button>
              </div>
            </div>

            <ol class="pairing__steps">
              <li><span class="step-bullet">1</span><span>Open Droply on the receiving device.</span></li>
              <li><span class="step-bullet">2</span><span>Choose Receive, then enter the code or scan.</span></li>
              <li><span class="step-bullet">3</span><span>Files start only after they accept.</span></li>
            </ol>

            <div class="share-url" title="${escapeHtml(receiveUrl)}">
              <i data-icon="link" data-size="13"></i>
              <span data-share-url>${escapeHtml(receiveUrl)}</span>
            </div>
          </div>

          <div class="pairing__side">
            <div class="qr" data-qr aria-label="Transfer QR code">
              <span class="qr__placeholder">Generating QR code…</span>
            </div>
            <p class="qr-caption">Scan with the receiving device</p>
          </div>
        </div>

        <div data-animation></div>

        <p class="stage-note" data-stage-note>
          Keep this tab open while waiting — closing it cancels the transfer.
        </p>
      </div>
    </section>
  `);

  qs(element, "[data-animation]").appendChild(animation.element);

  if (inviteName) {
    qs(element, "[data-stage-note]").textContent =
      `Invite sent to ${inviteName}. They still have to approve the files — keep this tab open.`;
  }

  /* QR code ---------------------------------------------------------------- */
  const qrBox = qs(element, "[data-qr]");
  try {
    if (typeof window.qrcode !== "function") throw new Error("QR library unavailable");
    const qr = window.qrcode(0, "M");
    qr.addData(receiveUrl);
    qr.make();
    qrBox.innerHTML = qr.createSvgTag({
      cellSize: 3,
      margin: 8,
      scalable: true,
      alt: `QR code for Droply transfer ${code}`,
    });
  } catch (error) {
    console.warn("[qr] could not render", error);
    qrBox.innerHTML = `<span class="qr__placeholder">QR unavailable.<br />Share the code instead.</span>`;
  }

  /* Copy code ------------------------------------------------------------- */
  const copyBtn = qs(element, "[data-copy]");
  const copyLabel = qs(element, "[data-copy-label]");
  let copyTimer = 0;
  copyBtn.addEventListener("click", async () => {
    const ok = await copyText(code);
    copyBtn.dataset.copied = String(ok);
    copyLabel.textContent = ok ? "Copied" : "Copy failed";
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copyBtn.dataset.copied = "false";
      copyLabel.textContent = "Copy";
    }, 2000);
  });

  /* Expiry countdown ------------------------------------------------------- */
  const expiryText = qs(element, "[data-expiry-text]");
  let expiryTimer = 0;
  const fallbackDeadline = Date.now() + 10 * 60_000;
  const parsedDeadline =
    typeof expiresAt === "number"
      ? expiresAt
      : expiresAt
        ? new Date(expiresAt).getTime()
        : Number.NaN;
  const deadline = Number.isFinite(parsedDeadline) ? parsedDeadline : fallbackDeadline;

  function tickExpiry() {
    const seconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    expiryText.textContent = seconds > 0 ? `${formatCountdown(seconds)} left` : "Room expired";
    if (seconds <= 0) window.clearInterval(expiryTimer);
  }
  tickExpiry();
  expiryTimer = window.setInterval(tickExpiry, 1000);

  qs(element, "[data-back]").addEventListener("click", onCancel);

  return {
    element,
    title: "Share transfer code",
    animation,
    dispose() {
      window.clearInterval(expiryTimer);
      window.clearTimeout(copyTimer);
    },
  };
}
