/** Live transfer UI plus the completion and failure screens. */

import {
  downloadUrl,
  el,
  escapeHtml,
  fileIcon,
  fileKind,
  iconsIn,
  qs,
  setProgress,
} from "./common.js";
import {
  formatBytes,
  formatDuration,
  formatFileCount,
  formatSpeed,
  toPercent,
} from "../utils/format-bytes.js";
import { inlineErrorMarkup } from "./error-view.js";
import { identityMarkup } from "./device-avatar.js";

/* --------------------------------------------------------------------------
   Screen 8 — live transfer
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   mode: "send"|"receive",
 *   files: Array<{ id?: string, name: string, size: number, type?: string }>,
 *   local?: object|null,
 *   peer?: object|null,
 *   onCancel: () => void
 * }} options
 */
export function mountTransfer({ mode, files, local = null, peer = null, onCancel }) {
  const verb = mode === "send" ? "Sending" : "Receiving";
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const element = el(`
    <section class="screen" aria-labelledby="transfer-title">
      <div class="stage">
        <div class="transfer-head">
          <div class="transfer-title">
            <span class="pill pill--blue" data-status>
              <span class="status-dot status-dot--live" aria-hidden="true"></span>
              <span data-status-text>${verb}</span>
            </span>
            <h1 id="transfer-title">${verb} ${formatFileCount(files.length)}</h1>
          </div>
          <div class="btn-group">
            <span class="pill" data-path hidden></span>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-cancel>
              <i data-icon="x" data-size="15"></i> Cancel
            </button>
          </div>
        </div>

        <div class="identity-strip" data-identity-strip>
          <div class="identity-strip__side">
            <div>
              <span class="identity-strip__label" data-local-label>
                ${mode === "send" ? "Sending from" : "Receiving on"}
              </span>
              <span data-local-identity></span>
            </div>
          </div>
          <span class="identity-strip__arrow" aria-hidden="true">→</span>
          <div class="identity-strip__side">
            <div>
              <span class="identity-strip__label" data-peer-label>
                ${mode === "send" ? "Sending to" : "From"}
              </span>
              <span data-peer-identity></span>
            </div>
          </div>
        </div>

        <div class="card transfer-body">
          <div class="overall">
            <div class="overall__top">
              <div>
                <div class="overall__value"><span data-percent>0</span><small>%</small></div>
                <div class="overall__label" data-of>of ${formatBytes(totalBytes)}</div>
              </div>
              <div class="overall__label tabular" data-bytes>0 B / ${formatBytes(totalBytes)}</div>
            </div>

            <div class="transfer-current">
              <span class="code-label">Now</span>
              <span class="transfer-current__name" data-current-file>Preparing…</span>
            </div>

            <div
              class="progress progress--brand progress--lg"
              data-progress
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="0"
              aria-label="Transfer progress"
            >
              <span class="progress__fill" data-fill></span>
            </div>

            <div class="stats">
              <div class="stat">
                <span class="stat__label">Speed</span>
                <span class="stat__value" data-speed>—</span>
              </div>
              <div class="stat">
                <span class="stat__label">Remaining</span>
                <span class="stat__value" data-eta>—</span>
              </div>
              <div class="stat">
                <span class="stat__label">Files</span>
                <span class="stat__value" data-files>0 / ${files.length}</span>
              </div>
            </div>
          </div>

          <hr class="divider" />

          <ul class="file-list files-transfer" data-file-rows></ul>
        </div>

        <p class="panel__hint" style="text-align: center">
          ${
            mode === "send"
              ? "Keep this tab open. The connection closes as soon as everything is sent."
              : "Keep this tab open. Save your files before closing it."
          }
        </p>
      </div>
    </section>
  `);

  const rows = qs(element, "[data-file-rows]");
  const percentNode = qs(element, "[data-percent]");
  const bytesNode = qs(element, "[data-bytes]");
  const fill = qs(element, "[data-fill]");
  const progressBar = qs(element, "[data-progress]");
  const currentFile = qs(element, "[data-current-file]");
  const speedNode = qs(element, "[data-speed]");
  const etaNode = qs(element, "[data-eta]");
  const filesNode = qs(element, "[data-files]");
  const statusPill = qs(element, "[data-status]");
  const statusText = qs(element, "[data-status-text]");
  const pathPill = qs(element, "[data-path]");
  const cancelBtn = qs(element, "[data-cancel]");
  const localSlot = qs(element, "[data-local-identity]");
  const peerSlot = qs(element, "[data-peer-identity]");

  /** Updates the two identity labels without replacing the screen. */
  function setIdentities({ local: nextLocal, peer: nextPeer } = {}) {
    if (nextLocal !== undefined) local = nextLocal;
    if (nextPeer !== undefined) peer = nextPeer;
    localSlot.innerHTML = local
      ? identityMarkup(local, { size: "sm" })
      : `<span class="device-identity__meta">This device</span>`;
    peerSlot.innerHTML = peer
      ? identityMarkup(peer, { size: "sm" })
      : `<span class="device-identity__meta">Waiting for the other device…</span>`;
  }

  setIdentities({});

  /** @type {Array<{ root: HTMLElement, fill: HTMLElement, pct: HTMLElement, bytes: HTMLElement, state: HTMLElement }>} */
  const rowRefs = files.map((file, index) => {
    const kind = fileKind(file);
    const li = document.createElement("li");
    li.className = "file-row file-row--transfer";
    li.dataset.index = String(index);
    li.innerHTML = `
      <span class="file-row__icon" data-kind="${kind}">
        <i data-icon="${fileIcon(kind)}" data-size="18"></i>
      </span>
      <div class="file-row__body">
        <div class="file-progress">
          <div class="file-progress__meta">
            <span class="file-row__name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="file-progress__pct" data-pct>0%</span>
          </div>
          <div class="progress progress--sm"><span class="progress__fill" data-row-fill></span></div>
          <div class="file-progress__meta">
            <span data-row-bytes>0 B / ${formatBytes(file.size)}</span>
            <span data-row-state>Waiting</span>
          </div>
        </div>
      </div>
    `;
    rows.appendChild(li);
    iconsIn(li);
    return {
      root: li,
      fill: qs(li, "[data-row-fill]"),
      pct: qs(li, "[data-pct]"),
      bytes: qs(li, "[data-row-bytes]"),
      state: qs(li, "[data-row-state]"),
    };
  });

  let complete = false;

  /**
   * @param {{
   *   ratio: number,
   *   transferredBytes: number,
   *   totalBytes: number,
   *   speed: number,
   *   eta: number|null,
   *   files: Array<{ ratio: number, transferred: number, size: number, state: string }>
   * }} detail
   */
  function update(detail) {
    if (!detail) return;
    const percent = detail.totalBytes === 0 && detail.complete ? 100 : toPercent(detail.ratio);
    percentNode.textContent = String(percent);
    setProgress(fill, detail.totalBytes === 0 ? (detail.complete ? 1 : 0) : detail.ratio);
    bytesNode.textContent = `${formatBytes(detail.transferredBytes)} / ${formatBytes(detail.totalBytes)}`;
    speedNode.textContent = formatSpeed(detail.speed);
    etaNode.textContent = detail.complete
      ? "—"
      : detail.eta == null
        ? "—"
        : formatDuration(detail.eta);

    const done = detail.files.filter((file) => file.state === "done").length;
    filesNode.textContent = `${done} / ${detail.files.length}`;
    progressBar?.setAttribute("aria-valuenow", String(percent));

    // Names the file that is actually moving right now; never invents one.
    const activeIndex = detail.files.findIndex((file) => file.state === "active");
    const activeName = activeIndex >= 0 ? files[activeIndex]?.name ?? "" : "";
    currentFile.textContent = activeName
      ? activeName
      : detail.complete
        ? "Every file delivered"
        : "Waiting for the first file";
    currentFile.title = currentFile.textContent;

    detail.files.forEach((file, index) => {
      const row = rowRefs[index];
      if (!row) return;
      const filePercent = file.size === 0 && file.state === "done" ? 100 : toPercent(file.ratio);
      row.pct.textContent = `${filePercent}%`;
      row.bytes.textContent = `${formatBytes(file.transferred)} / ${formatBytes(file.size)}`;
      setProgress(row.fill, file.size === 0 ? (file.state === "done" ? 1 : 0) : file.ratio);
      row.state.textContent =
        file.state === "done"
          ? "Complete"
          : file.state === "active"
            ? mode === "send"
              ? "Sending"
              : "Receiving"
            : "Waiting";
      row.root.dataset.done = String(file.state === "done");
      row.root.classList.toggle("file-row--done", file.state === "done");
      row.fill.classList.toggle("progress--success", file.state === "done");
    });
  }

  function setStatus({ label, tone = "blue" } = {}) {
    if (label) statusText.textContent = label;
    statusPill.className = `pill pill--${tone}`;
    const dot = statusPill.querySelector(".status-dot");
    if (dot) dot.className = tone === "success" ? "status-dot" : "status-dot status-dot--live";
  }

  /** Honest labelling of the route WebRTC actually selected. */
  function setPath(path) {
    if (!pathPill) return;
    if (path === "direct") {
      pathPill.hidden = false;
      pathPill.className = "pill pill--success";
      pathPill.textContent = "Direct connection";
    } else if (path === "relayed") {
      pathPill.hidden = false;
      pathPill.className = "pill pill--blue";
      pathPill.textContent = "Relayed via TURN";
    } else {
      pathPill.hidden = true;
    }
  }

  function setCancelEnabled(enabled) {
    cancelBtn.disabled = !enabled;
  }

  function markComplete() {
    complete = true;
    setStatus({ label: "Complete", tone: "success" });
    setProgress(fill, 1);
    percentNode.textContent = "100";
    cancelBtn.hidden = true;
  }

  cancelBtn.addEventListener("click", () => {
    if (complete) return;
    cancelBtn.disabled = true;
    onCancel();
  });

  // Prime the rows so the layout never jumps on the first progress tick.
  update({
    ratio: 0,
    transferredBytes: 0,
    totalBytes,
    speed: 0,
    eta: null,
    complete: false,
    files: files.map((file) => ({
      ratio: 0,
      transferred: 0,
      size: file.size,
      state: "pending",
    })),
  });

  return {
    element,
    title: `${verb} files`,
    update,
    setStatus,
    setPath,
    setCancelEnabled,
    markComplete,
    setIdentities,
  };
}

/* --------------------------------------------------------------------------
   Screen 9 — completion
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   mode: "send"|"receive",
 *   files: Array<{ name: string, size: number, url?: string }>,
 *   totalBytes: number,
 *   elapsedSeconds?: number,
 *   local?: object|null,
 *   peer?: object|null,
 *   onDone: () => void
 * }} options
 */
export function mountTransferComplete({ mode, files, totalBytes, elapsedSeconds, local = null, peer = null, onDone }) {
  const fromIdentity = mode === "send" ? local : peer;
  const toIdentity = mode === "send" ? peer : local;
  const fromLabel = mode === "send" ? "Sent from" : "Received from";
  const toLabel = mode === "send" ? "Delivered to" : "Saved on";
  const fromFallback = mode === "send" ? "This device" : "Other device";
  const toFallback = mode === "send" ? "Other device" : "This device";
  const element = el(`
    <section class="screen" aria-labelledby="complete-title">
      <div class="stage stage--narrow">
        <div class="card result">
          <span class="result__badge"><i data-icon="check" data-size="34"></i></span>
          <span class="pill pill--success">Room closed</span>
          <h1 class="result__title" id="complete-title">Transfer complete</h1>
          <p class="result__text">
            ${
              mode === "send"
                ? "Every file reached the other device. The encrypted connection is now closed."
                : "Every file arrived and its byte count was verified. Save them before closing this tab."
            }
          </p>

          <div class="identity-strip" data-complete-identities>
            <div class="identity-strip__side">
              <div>
                <span class="identity-strip__label">${fromLabel}</span>
                ${identityMarkup(fromIdentity, { size: "sm", fallback: fromFallback })}
              </div>
            </div>
            <span class="identity-strip__arrow" aria-hidden="true">→</span>
            <div class="identity-strip__side">
              <div>
                <span class="identity-strip__label">${toLabel}</span>
                ${identityMarkup(toIdentity, { size: "sm", fallback: toFallback })}
              </div>
            </div>
          </div>

          <dl class="result__stats">
            <div class="result__stat">
              <dt>Files</dt>
              <dd>${formatFileCount(files.length)}</dd>
            </div>
            <div class="result__stat">
              <dt>Transferred</dt>
              <dd>${formatBytes(totalBytes)}</dd>
            </div>
            <div class="result__stat">
              <dt>Time</dt>
              <dd>${elapsedSeconds ? formatDuration(elapsedSeconds) : "—"}</dd>
            </div>
          </dl>

          <div data-downloads></div>

          <button type="button" class="btn btn--primary btn--lg" data-done>Done</button>
        </div>
      </div>
    </section>
  `);

  const downloads = qs(element, "[data-downloads]");
  const withUrls = files.filter((file) => file.url);

  /** Saves one file; a browser refusal is reported instead of swallowed. */
  let downloadFailureShown = false;
  function saveFile(file) {
    try {
      if (!file.url) throw new Error("The received data is no longer available in this tab.");
      downloadUrl(file.url, file.name);
    } catch {
      if (downloadFailureShown) return;
      downloadFailureShown = true;
      downloads.insertAdjacentHTML("afterbegin", inlineErrorMarkup("download/failed"));
      iconsIn(downloads);
    }
  }

  if (mode === "receive" && withUrls.length) {
    const wrapper = document.createElement("div");
    wrapper.className = "downloads";
    wrapper.innerHTML = `
      <div class="btn-group btn-group--between" style="margin-bottom: 4px">
        <span class="code-label">Save files</span>
        <button type="button" class="btn btn--secondary btn--sm" data-save-all>
          <i data-icon="hard-drive-download" data-size="15"></i> Save all
        </button>
      </div>
      <div data-rows></div>
    `;
    const rowHost = wrapper.querySelector("[data-rows]");

    for (const file of withUrls) {
      const row = document.createElement("div");
      row.className = "download-row";
      row.innerHTML = `
        <span class="file-row__icon" data-kind="${fileKind(file)}">
          <i data-icon="${fileIcon(fileKind(file))}" data-size="16"></i>
        </span>
        <span class="download-row__body">
          <span class="download-row__name"></span>
          <span class="download-row__size">${formatBytes(file.size)}</span>
        </span>
        <button type="button" class="btn btn--secondary btn--sm">
          <i data-icon="download" data-size="14"></i> Save
        </button>
      `;
      row.querySelector(".download-row__name").textContent = file.name;
      row.querySelector("button").addEventListener("click", () => saveFile(file));
      rowHost.appendChild(row);
    }

    wrapper.querySelector("[data-save-all]").addEventListener("click", () => {
      // Sequential clicks can be throttled by the browser; stagger slightly.
      withUrls.forEach((file, index) => {
        window.setTimeout(() => saveFile(file), index * 350);
      });
    });

    downloads.appendChild(wrapper);
    iconsIn(downloads);
  }

  qs(element, "[data-done]").addEventListener("click", onDone);

  return { element, title: "Transfer complete" };
}

/* --------------------------------------------------------------------------
   Error state
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   title: string,
 *   message: string,
 *   hint?: string,
 *   actions?: Array<{ label: string, onClick: () => void, variant?: "primary"|"secondary"|"ghost", icon?: string }>,
 *   tone?: "default"|"error"
 * }} options
 */
export function mountResultError({ title, message, hint, actions = [], tone = "error" }) {
  const element = el(`
    <section class="screen" aria-labelledby="error-title">
      <div class="stage stage--narrow">
        <div class="card result ${tone === "error" ? "result--error" : ""}">
          <span class="result__badge">
            <i data-icon="${tone === "error" ? "circle-alert" : "shield-check"}" data-size="32"></i>
          </span>
          <h1 class="result__title" id="error-title">${escapeHtml(title)}</h1>
          <p class="result__text">${escapeHtml(message)}</p>
          ${hint ? `<div class="alert alert--info"><i data-icon="lock" data-size="15"></i><span>${escapeHtml(hint)}</span></div>` : ""}
          <div class="btn-group" data-actions></div>
        </div>
      </div>
    </section>
  `);

  const host = qs(element, "[data-actions]");
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn--${action.variant ?? "primary"}`;
    if (action.icon) button.innerHTML = `<i data-icon="${action.icon}" data-size="16"></i>`;
    button.appendChild(document.createTextNode(action.label));
    button.addEventListener("click", action.onClick);
    host.appendChild(button);
  }
  iconsIn(element);

  return { element, title };
}
