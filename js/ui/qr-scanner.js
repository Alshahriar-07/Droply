/**
 * Camera QR scanning. Permission is requested only when this screen mounts,
 * which itself only happens after the user chooses "Scan QR". The camera is
 * released immediately after a successful scan or when the screen is left.
 */

import { el, iconsIn, qs } from "./common.js";
import { isSecureContext } from "../config.js";
import { extractRoomCode } from "../utils/validation.js";
import { describeError } from "../core/errors.js";

const SCAN_INTERVAL_MS = 130;
const MAX_DECODE_WIDTH = 640;

export class QrScanner {
  /**
   * @param {{
   *   video: HTMLVideoElement,
   *   onResult: (value: string) => void,
   *   onError: (errorId: string) => void,
   *   parse?: (text: string) => string|null
   * }} options `parse` turns decoded text into the value to accept; returning
   *   null means "not this kind of code" and keeps scanning.
   */
  constructor({ video, onResult, onError, parse = extractRoomCode }) {
    this.video = video;
    this.onResult = onResult;
    this.onError = onError;
    this.parse = parse;
    this.stream = null;
    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    this.timer = 0;
    this.active = false;
    this.stopped = false;
  }

  async start() {
    if (this.active) return;
    this.stopped = false;

    if (!isSecureContext()) {
      this.onError("camera/unavailable");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onError("camera/unavailable");
      return;
    }
    if (typeof window.jsQR !== "function") {
      this.onError("qr/unavailable");
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (error) {
      this.onError(this.#cameraErrorId(error));
      return;
    }

    if (this.stopped) {
      // The user left while the permission prompt was open.
      this.#stopTracks();
      return;
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "");
    this.video.muted = true;
    try {
      await this.video.play();
    } catch {
      /* Autoplay of a muted stream can still be blocked; the loop retries. */
    }
    this.active = true;
    this.#tick();
  }

  /** Maps a getUserMedia failure onto a catalog entry. */
  #cameraErrorId(error) {
    switch (error?.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "camera/denied";
      case "NotFoundError":
      case "OverconstrainedError":
      case "NotReadableError":
        return "camera/unavailable";
      default:
        return "camera/unavailable";
    }
  }

  #tick() {
    if (!this.active || this.stopped) return;
    this.timer = window.setTimeout(() => {
      this.#decodeFrame();
      this.#tick();
    }, SCAN_INTERVAL_MS);
  }

  #decodeFrame() {
    const { video } = this;
    if (!video.videoWidth || !video.videoHeight || !this.context) return;

    const scale = Math.min(1, MAX_DECODE_WIDTH / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    try {
      this.context.drawImage(video, 0, 0, width, height);
    } catch {
      return;
    }

    let imageData;
    try {
      imageData = this.context.getImageData(0, 0, width, height);
    } catch {
      return;
    }

    let result;
    try {
      result = window.jsQR(imageData.data, width, height, {
        inversionAttempts: "dontInvert",
      });
    } catch {
      return;
    }

    if (!result?.data) return;
    const value = this.parse(result.data);
    if (!value) {
      this.onError("qr/invalid");
      return;
    }
    this.stop();
    this.onResult(value);
  }

  #stopTracks() {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    try {
      this.video.srcObject = null;
    } catch {
      /* ignore */
    }
  }

  stop() {
    this.stopped = true;
    this.active = false;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.#stopTracks();
  }
}

/* --------------------------------------------------------------------------
   Screen — QR scanning
   -------------------------------------------------------------------------- */

/**
 * @param {{
 *   onBack: () => void,
 *   onCode: () => void,
 *   onDetected: (code: string) => void
 * }} options
 */
export function mountQrScanner({ onBack, onCode, onDetected }) {
  const element = el(`
    <section class="screen" aria-labelledby="scan-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Back
          </button>
          <span class="pill">Scan QR</span>
        </div>

        <div class="screen-head">
          <h1 id="scan-title">Scan the sender's QR code</h1>
          <p>Hold the sending device's screen inside the frame. The camera stops as soon as a code is read.</p>
        </div>

        <div class="card card--padded panel">
          <div class="scanner" data-active="false" data-scanner>
            <video data-video playsinline muted aria-label="Camera preview"></video>
            <div class="scanner__placeholder" data-placeholder>
              <span class="spinner spinner--lg" aria-hidden="true"></span>
              <span>Starting camera…</span>
            </div>
            <div class="scanner__frame" aria-hidden="true"></div>
            <div class="scanner__hint" data-hint>Point the camera at the Droply QR code</div>
          </div>

          <div class="alert alert--danger" data-error hidden>
            <i data-icon="circle-alert" data-size="16"></i>
            <span data-error-text></span>
          </div>

          <div class="btn-group btn-group--between">
            <button type="button" class="btn btn--secondary" data-manual>
              <i data-icon="keyboard" data-size="16"></i> Enter code instead
            </button>
            <button type="button" class="btn btn--ghost" data-cancel>Cancel</button>
          </div>
        </div>

        <p class="panel__hint" style="text-align: center">
          Camera access is used only for this scan and is released immediately afterwards.
        </p>
      </div>
    </section>
  `);

  const scannerEl = qs(element, "[data-scanner]");
  const placeholder = qs(element, "[data-placeholder]");
  const errorBox = qs(element, "[data-error]");
  const errorText = qs(element, "[data-error-text]");
  const hint = qs(element, "[data-hint]");
  const video = qs(element, "[data-video]");

  /** Renders a catalog error inline, with its recovery step(s). */
  function showError(errorId) {
    const spec = describeError(errorId);
    errorBox.innerHTML = `
      <i data-icon="${spec.icon}" data-size="16"></i>
      <span class="alert__body">
        <strong>${spec.title}</strong>
        <span>${spec.message}</span>
        ${spec.recovery.length ? `<span class="alert__hint">${spec.recovery[0]}</span>` : ""}
      </span>
    `;
    iconsIn(errorBox);
    errorBox.hidden = false;
    placeholder.hidden = true;
    hint.hidden = true;
  }

  const scanner = new QrScanner({
    video,
    onResult: (code) => {
      scannerEl.dataset.active = "false";
      placeholder.hidden = false;
      placeholder.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Connecting…</span>`;
      onDetected(code);
    },
    onError: (errorId) => {
      // A non-Droply QR is transient: keep scanning, but say what was seen.
      if (errorId === "qr/invalid") {
        const spec = describeError(errorId);
        errorText.textContent = spec.message;
        errorBox.hidden = false;
        window.setTimeout(() => {
          errorBox.hidden = true;
        }, 3200);
        return;
      }
      showError(errorId);
    },
  });

  scanner.start().then(() => {
    if (scanner.active) {
      scannerEl.dataset.active = "true";
      placeholder.hidden = true;
    } else {
      placeholder.hidden = true;
    }
  });

  // Pause decoding when the tab is hidden; keep the stream so returning is instant.
  const onVisibility = () => {
    if (document.hidden) scanner.stop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const cleanup = () => {
    scanner.stop();
    document.removeEventListener("visibilitychange", onVisibility);
  };

  qs(element, "[data-back]").addEventListener("click", () => {
    cleanup();
    onBack();
  });
  qs(element, "[data-cancel]").addEventListener("click", () => {
    cleanup();
    onBack();
  });
  qs(element, "[data-manual]").addEventListener("click", () => {
    cleanup();
    onCode();
  });

  return {
    element,
    title: "Scan QR code",
    dispose: cleanup,
  };
}
