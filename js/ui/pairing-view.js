/**
 * Pairing screen.
 *
 * One six-character code does the rendezvous; the security still comes from the
 * ECDH short authentication string both screens show afterwards. The code is
 * displayed large, copies in one click, works as a QR link, counts down from
 * five minutes, can be regenerated, and is single-use.
 */

import { QrScanner } from "./qr-scanner.js";
import { pairingLink } from "../config.js";
import {
  PAIRING_CODE_PATTERN,
  acceptPairingPeer,
  closePairingSession,
  codeFromPairingText,
  createPairingSession,
  fetchPairingStatus,
  joinPairingSession,
  normalizePairingCode,
  regeneratePairingSession,
} from "../core/pairing.js";
import { copyText, el, iconsIn, qs, toast } from "./common.js";
import { identityMarkup } from "./device-avatar.js";
import { formatCountdown } from "../utils/format-bytes.js";

function renderQr(box, text, alt) {
  try {
    if (typeof window.qrcode !== "function") throw new Error("QR library unavailable");
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 8, scalable: true, alt });
    return true;
  } catch (error) {
    console.warn("[pairing] QR render failed", error);
    box.innerHTML = `<span class="qr__placeholder">QR unavailable.<br />Share the six-character code instead.</span>`;
    return false;
  }
}

/**
 * @param {{
 *   identityPromise: Promise<{ deviceId: string, name: string }>,
 *   initialCode?: string,
 *   onBack: () => void,
 *   onSave: (contact: object) => Promise<object|void>
 * }} options
 */
export function mountPairing({ identityPromise, initialCode = "", onBack, onSave }) {
  let identity = null;
  /** @type {{code: string, token: string, expiresAt: number}|null} */
  let session = null;
  /** @type {{sas: string, contact: object}|null} */
  let pending = null;
  let role = "owner";
  let busy = false;
  let finished = false;
  let expired = false;
  let disposed = false;
  let pollTimer = 0;
  let tickTimer = 0;
  let pollBusy = false;
  let scanner = null;

  const element = el(`
    <section class="screen" aria-labelledby="pair-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Back
          </button>
          <span class="pill"><i data-icon="lock" data-size="13"></i> Pairing</span>
        </div>

        <div class="screen-head">
          <h1 id="pair-title">Pair a device</h1>
          <p>
            Share a six-character code, or enter the one on the other device. Both screens then show
            the same verification digits — compare them before saving.
          </p>
        </div>

        <div class="identity-strip" data-self-strip hidden>
          <div class="identity-strip__side">
            <div>
              <span class="identity-strip__label">This device</span>
              <span data-self-identity></span>
            </div>
          </div>
        </div>

        <div class="alert alert--danger alert--rich" data-error role="alert" hidden>
          <i data-icon="circle-alert" data-size="16"></i>
          <span class="alert__body" data-error-text></span>
        </div>

        <div class="card pairing-panel" data-compare hidden>
          <div class="pairing-compare">
            <span class="code-label">Verify both devices show</span>
            <div class="sas-code" data-sas>— — —</div>
            <p class="pairing-compare__hint" data-compare-name></p>
            <p class="pairing-compare__hint">
              If the other device shows different digits, cancel. Do not save it.
            </p>
            <div class="btn-group">
              <button type="button" class="btn btn--primary" data-confirm>
                <i data-icon="check" data-size="16"></i> Digits match — save device
              </button>
              <button type="button" class="btn btn--secondary" data-cancel-compare>Cancel</button>
            </div>
          </div>
        </div>

        <div class="card pairing-panel" data-success hidden>
          <div class="result result--bare">
            <span class="result__badge"><i data-icon="check" data-size="26"></i></span>
            <h2 class="result__title">Device saved</h2>
            <p class="result__text" data-success-text></p>
            <p class="stage-note">
              The other device saves you separately. Once both have confirmed, you can send without a
              code.
            </p>
            <div class="btn-group">
              <button type="button" class="btn btn--secondary btn--sm" data-success-done>Done</button>
            </div>
          </div>
        </div>

        <div class="card card--padded pairing-panel" data-main>
          <div class="pairing-grid">
            <div class="pairing-grid__code">
              <span class="code-label">Your pairing code</span>
              <div class="code-display">
                <span class="code-display__value" data-code aria-live="polite">——————</span>
                <button type="button" class="copy-btn" data-copy>
                  <i data-icon="copy" data-size="14"></i>
                  <span data-copy-label>Copy code</span>
                </button>
              </div>

              <div class="qr" data-qr aria-label="QR code for this pairing code">
                <span class="qr__placeholder">Creating a code…</span>
              </div>
              <p class="qr-caption">Scan this, or type the code on the other device</p>

              <div class="btn-group">
                <span class="pill" data-expiry hidden>
                  <i data-icon="clock" data-size="13"></i>
                  <span data-expiry-text>5:00 left</span>
                </span>
                <button type="button" class="btn btn--ghost btn--sm" data-regenerate>
                  <i data-icon="rotate-cw" data-size="14"></i> Regenerate
                </button>
              </div>

              <p class="stage-note" data-status-text aria-live="polite">
                Creating a pairing code…
              </p>
            </div>

            <div class="pairing-grid__scan">
              <form class="pairing-paste" data-join-form novalidate>
                <label class="code-label" for="pair-code">Enter their code</label>
                <div class="code-slots" data-slots>
                  <span class="code-slot" data-slot="0"></span>
                  <span class="code-slot" data-slot="1"></span>
                  <span class="code-slot" data-slot="2"></span>
                  <span class="code-slot" data-slot="3"></span>
                  <span class="code-slot" data-slot="4"></span>
                  <span class="code-slot" data-slot="5"></span>
                  <input
                    class="code-slots__input"
                    id="pair-code"
                    data-input
                    type="text"
                    inputmode="text"
                    autocomplete="off"
                    autocapitalize="characters"
                    autocorrect="off"
                    spellcheck="false"
                    maxlength="6"
                    aria-label="Six-character pairing code"
                  />
                </div>
                <div class="code-help">
                  <span>Six letters or numbers. No O, 0, I or 1.</span>
                  <span class="tabular" data-length>0 / 6</span>
                </div>
                <button type="submit" class="btn btn--blue btn--block" data-join disabled>
                  Pair device
                </button>
                <p class="qr-caption">Codes expire after five minutes and work once.</p>
              </form>

              <button type="button" class="btn btn--secondary btn--block" data-camera>
                <i data-icon="camera" data-size="16"></i> Scan their QR instead
              </button>

              <div class="scanner scanner--compact" data-scanner data-active="false" hidden>
                <video data-video playsinline muted aria-label="Camera preview"></video>
                <div class="scanner__placeholder" data-placeholder>
                  <span class="spinner spinner--lg" aria-hidden="true"></span>
                  <span>Starting camera…</span>
                </div>
                <div class="scanner__frame" aria-hidden="true"></div>
              </div>
            </div>
          </div>
        </div>

        <p class="stage-note">
          Only public keys are exchanged. Private keys never leave this browser and can't be exported.
        </p>
      </div>
    </section>
  `);

  const els = {
    errorBox: qs(element, "[data-error]"),
    errorText: qs(element, "[data-error-text]"),
    compare: qs(element, "[data-compare]"),
    sas: qs(element, "[data-sas]"),
    compareName: qs(element, "[data-compare-name]"),
    confirm: qs(element, "[data-confirm]"),
    success: qs(element, "[data-success]"),
    successText: qs(element, "[data-success-text]"),
    main: qs(element, "[data-main]"),
    selfStrip: qs(element, "[data-self-strip]"),
    selfIdentity: qs(element, "[data-self-identity]"),
    code: qs(element, "[data-code]"),
    copyLabel: qs(element, "[data-copy-label]"),
    qr: qs(element, "[data-qr]"),
    expiry: qs(element, "[data-expiry]"),
    expiryText: qs(element, "[data-expiry-text]"),
    statusText: qs(element, "[data-status-text]"),
    regenerate: qs(element, "[data-regenerate]"),
    form: qs(element, "[data-join-form]"),
    input: qs(element, "[data-input]"),
    slots: Array.from(element.querySelectorAll("[data-slot]")),
    length: qs(element, "[data-length]"),
    join: qs(element, "[data-join]"),
    camera: qs(element, "[data-camera]"),
    scannerEl: qs(element, "[data-scanner]"),
    video: qs(element, "[data-video]"),
    placeholder: qs(element, "[data-placeholder]"),
  };

  function showError(message) {
    els.errorText.textContent = String(message ?? "");
    els.errorBox.hidden = false;
  }

  function clearError() {
    els.errorBox.hidden = true;
    els.errorText.textContent = "";
  }

  function renderSlots() {
    const value = els.input.value;
    const activeIndex = Math.min(value.length, els.slots.length - 1);
    const focused = document.activeElement === els.input;
    els.slots.forEach((slot, index) => {
      const char = value[index] ?? "";
      slot.textContent = char;
      slot.dataset.filled = String(Boolean(char));
      slot.dataset.active = String(index === activeIndex);
      slot.dataset.caret = String(index === value.length && focused && value.length < 6);
    });
    els.length.textContent = `${value.length} / 6`;
    els.join.disabled = busy || finished || value.length !== 6;
  }

  /* ----------------------------- countdown ----------------------------- */

  function tick() {
    if (!session) return;
    const seconds = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000));
    els.expiry.hidden = false;
    els.expiryText.textContent = seconds > 0 ? `${formatCountdown(seconds)} left` : "Expired";
    els.expiry.dataset.tone = seconds > 0 ? "live" : "expired";
    if (seconds <= 0 && !expired) {
      expired = true;
      stopPolling();
      if (!pending) els.statusText.textContent = "This code expired. Regenerate it for a new one.";
    }
  }

  /* ------------------------------ polling ------------------------------ */

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(() => void poll(), 2500);
  }

  async function poll() {
    if (!session || pending || expired || pollBusy || disposed || role !== "owner") return;
    pollBusy = true;
    try {
      const result = await fetchPairingStatus(session);
      if (disposed || pending) return;
      session.expiresAt = result.expiresAt;
      if (result.state === "joined" && result.peer) {
        stopPolling();
        await enterCompare(result.peer, "owner");
      }
    } catch (error) {
      if (disposed) return;
      if (error?.status === 404 || error?.code === "pairing/pair_expired") {
        expired = true;
        stopPolling();
        els.statusText.textContent = "This code is no longer active. Regenerate it.";
      }
    } finally {
      pollBusy = false;
    }
  }

  /* ---------------------------- main flow ---------------------------- */

  function renderSession() {
    if (!session) return;
    els.code.textContent = session.code;
    renderQr(els.qr, pairingLink(session.code), `Pairing code ${session.code}`);
    els.statusText.textContent = "Waiting for the other device to enter this code…";
    els.expiry.hidden = false;
    expired = false;
    tick();
    renderSlots();
  }

  async function startSession() {
    if (!identity || disposed) return;
    els.code.textContent = "——————";
    els.qr.innerHTML = `<span class="qr__placeholder">Creating a code…</span>`;
    els.statusText.textContent = "Creating a pairing code…";
    els.expiry.hidden = true;
    try {
      session = await createPairingSession(identity);
      renderSession();
      startPolling();
    } catch (error) {
      session = null;
      els.code.textContent = "—";
      els.qr.innerHTML = `<span class="qr__placeholder">Pairing is unavailable</span>`;
      els.statusText.textContent = "Your own code couldn't be created. You can still enter the other device's code.";
      showError(error?.message ?? "Pairing couldn't start. Try again.");
    }
  }

  async function enterCompare(peer, asRole) {
    if (!identity) return;
    try {
      const result = await acceptPairingPeer(identity, peer);
      role = asRole;
      pending = result;
      els.sas.textContent = result.sas;
      els.compareName.innerHTML = `Pairing with ${identityMarkup(result.contact, { size: "sm" })}`;
      els.compare.hidden = false;
      els.main.hidden = true;
      els.success.hidden = true;
      clearError();
      stopCamera();
      els.compare.scrollIntoView({ block: "nearest" });
    } catch (error) {
      showError(error?.message ?? "That pairing code could not be used.");
    }
  }

  function restoreJoinButton() {
    els.join.innerHTML = "Pair device";
    iconsIn(els.join);
  }

  async function join() {
    if (busy || !identity) return;
    const code = normalizePairingCode(els.input.value);
    if (!PAIRING_CODE_PATTERN.test(code)) {
      showError(
        "That code isn't valid. A pairing code is six letters or numbers, without O, 0, I or 1.",
      );
      return;
    }
    busy = true;
    clearError();
    els.join.disabled = true;
    els.join.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Checking code…</span>`;
    try {
      const result = await joinPairingSession(identity, code);
      role = "joiner";
      stopPolling();
      await enterCompare(result.owner, "joiner");
    } catch (error) {
      showError(error?.message ?? "That pairing code could not be used.");
    } finally {
      busy = false;
      restoreJoinButton();
      renderSlots();
    }
  }

  function resetInput() {
    els.input.value = "";
    renderSlots();
  }

  /* ----------------------------- controls ----------------------------- */

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void join();
  });

  els.input.addEventListener("input", () => {
    const normalized = normalizePairingCode(els.input.value);
    if (els.input.value !== normalized) els.input.value = normalized;
    clearError();
    renderSlots();
  });

  els.input.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text") ?? "";
    const code = codeFromPairingText(text);
    els.input.value = code;
    clearError();
    if (!code && text.trim()) {
      showError("That didn't contain a pairing code. A code is six letters or numbers.");
    }
    renderSlots();
  });

  els.input.addEventListener("focus", renderSlots);
  els.input.addEventListener("blur", renderSlots);

  qs(element, "[data-copy]").addEventListener("click", async () => {
    if (!session) return;
    const ok = await copyText(session.code);
    els.copyLabel.textContent = ok ? "Copied" : "Copy failed";
    window.setTimeout(() => {
      els.copyLabel.textContent = "Copy code";
    }, 2000);
    if (!ok) toast("Select the code and copy it manually.");
  });

  els.regenerate.addEventListener("click", async () => {
    if (busy) return;
    if (!session) {
      await startSession();
      return;
    }
    busy = true;
    els.regenerate.disabled = true;
    try {
      const next = await regeneratePairingSession(session);
      session = next;
      pending = null;
      els.compare.hidden = true;
      els.success.hidden = true;
      els.main.hidden = false;
      clearError();
      renderSession();
      startPolling();
      toast("New pairing code ready.", { tone: "success" });
    } catch (error) {
      showError(error?.message ?? "Couldn't create a new code. Try again.");
      if (error?.code === "pairing/pair_not_found" || error?.code === "pairing/pair_expired") {
        await startSession();
      }
    } finally {
      busy = false;
      els.regenerate.disabled = false;
    }
  });

  qs(element, "[data-cancel-compare]").addEventListener("click", () => {
    pending = null;
    els.compare.hidden = true;
    els.main.hidden = false;
    clearError();
    resetInput();
    if (role === "owner") {
      stopPolling();
      els.statusText.textContent =
        "This session has already been used. Regenerate the code to pair another device.";
    } else {
      els.statusText.textContent = "Enter another code, or share your own on the left.";
    }
  });

  els.confirm.addEventListener("click", async () => {
    if (!pending || busy) return;
    busy = true;
    els.confirm.disabled = true;
    const contact = pending.contact;
    els.confirm.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Saving…</span>`;
    try {
      await onSave(contact);
      finished = true;
      stopPolling();
      stopCamera();
      if (role === "owner" && session) void closePairingSession(session);
      els.compare.hidden = true;
      els.main.hidden = true;
      els.success.hidden = false;
      els.successText.textContent = `${contact.name} is saved on this browser.`;
      pending = null;
    } catch (error) {
      showError(error?.message ?? "That device could not be saved.");
    } finally {
      busy = false;
      els.confirm.disabled = false;
      els.confirm.innerHTML = `<i data-icon="check" data-size="16"></i> Digits match — save device`;
      iconsIn(els.confirm);
    }
  });

  qs(element, "[data-success-done]").addEventListener("click", onBack);

  els.camera.addEventListener("click", async () => {
    clearError();
    els.camera.hidden = true;
    els.scannerEl.hidden = false;
    els.placeholder.hidden = false;
    els.placeholder.innerHTML = `<span class="spinner spinner--lg" aria-hidden="true"></span><span>Starting camera…</span>`;

    if (!scanner) {
      scanner = new QrScanner({
        video: els.video,
        parse: (text) => codeFromPairingText(text) || null,
        onResult: (code) => {
          els.scannerEl.dataset.active = "false";
          els.input.value = normalizePairingCode(code);
          renderSlots();
          void join();
        },
        onError: (errorId) => {
          if (errorId === "qr/invalid") return; // another QR code; keep scanning
          stopCamera();
          showError(
            errorId === "camera/denied"
              ? "Camera access was denied. Enter the six-character code instead."
              : "The camera isn't available. Enter the code instead.",
          );
        },
      });
    }
    await scanner.start();
    if (scanner.active) {
      els.scannerEl.dataset.active = "true";
      els.placeholder.hidden = true;
    } else {
      els.camera.hidden = false;
      els.placeholder.hidden = true;
    }
  });

  function stopCamera() {
    if (scanner) scanner.stop();
    els.scannerEl.dataset.active = "false";
    els.scannerEl.hidden = true;
    els.camera.hidden = false;
  }

  qs(element, "[data-back]").addEventListener("click", () => {
    stopCamera();
    onBack();
  });

  /* ------------------------------ startup ------------------------------ */

  els.input.value = normalizePairingCode(initialCode);
  renderSlots();
  tickTimer = window.setInterval(tick, 1000);

  identityPromise
    .then((loaded) => {
      identity = loaded;
      els.selfIdentity.innerHTML = identityMarkup(identity, { size: "sm" });
      els.selfStrip.hidden = false;
      if (initialCode) els.input.focus({ preventScroll: true });
      return startSession();
    })
    .catch((error) => {
      els.code.textContent = "—";
      els.qr.innerHTML = `<span class="qr__placeholder">Pairing unavailable</span>`;
      els.statusText.textContent = "This browser blocked device storage, so pairing can't start.";
      showError(error?.message ?? "This browser blocked device storage, so pairing can't start.");
    });

  return {
    element,
    title: "Pair a device",
    dispose() {
      disposed = true;
      stopPolling();
      window.clearInterval(tickTimer);
      stopCamera();
      if (session && role === "owner" && !finished) void closePairingSession(session);
    },
  };
}
