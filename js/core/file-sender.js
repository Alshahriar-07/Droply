/**
 * Streams selected files over the data channel.
 *
 * - reads the file with File.slice() in 256 KiB blocks, so a multi-GB file is
 *   never loaded into memory at once
 * - splits each block into `chunkSize` frames (32 KiB by default)
 * - waits for the channel's send buffer to drain before reading more
 * - reports progress from bytes actually handed to the channel
 */

import { config } from "../config.js";
import { clamp, sanitizeMimeType } from "../utils/validation.js";
import { SpeedMeter } from "../utils/speed-meter.js";
import {
  CONTROL,
  CANCEL_REASON,
  cancelMessage,
  encodeChunk,
  fileEndMessage,
  fileStartMessage,
} from "./transfer-protocol.js";
import { buildProgressDetail } from "./transfer-stats.js";

const READ_BLOCK_MIN = 64 * 1024;

export class FileSender extends EventTarget {
  /**
   * @param {{ transport: import("./data-channel.js").DataChannelTransport, files: File[], chunkSize?: number }} options
   */
  constructor({ transport, files, chunkSize = config.chunkSize }) {
    super();
    this.transport = transport;
    this.chunkSize = Math.round(clamp(chunkSize, 16 * 1024, 64 * 1024));
    this.readBlockSize = Math.max(this.chunkSize * 8, READ_BLOCK_MIN);

    this.entries = files.map((file, index) => ({
      id: `f${index}`,
      file,
      name: file.name || `file-${index + 1}`,
      size: file.size,
      type: sanitizeMimeType(file.type),
      transferred: 0,
    }));

    this.totalBytes = this.entries.reduce((sum, entry) => sum + entry.size, 0);
    this.sentBytes = 0;
    this.activeIndex = -1;
    this.started = false;
    this.finished = false;
    this.aborted = false;
    this.abortController = new AbortController();
    this.speed = new SpeedMeter();
    this.emitTimer = 0;
    this.lastEmitAt = 0;
    this.manifestAccepted = false;
  }

  /** Metadata sent to the receiver before any bytes move. */
  get manifest() {
    return {
      t: CONTROL.MANIFEST,
      files: this.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        size: entry.size,
        type: entry.type,
      })),
      totalBytes: this.totalBytes,
      chunkSize: this.chunkSize,
    };
  }

  /** Sends file metadata and waits for the receiver's consent. */
  sendManifest() {
    this.transport.sendControl(this.manifest);
  }

  markAccepted() {
    this.manifestAccepted = true;
  }

  /**
   * Starts streaming. Must only be called after the receiver accepted.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.started) throw new Error("This transfer already started.");
    if (!this.manifestAccepted) throw new Error("The receiver has not accepted yet.");
    this.started = true;
    this.speed.reset();

    try {
      for (let index = 0; index < this.entries.length; index += 1) {
        if (this.aborted) throw new DOMException("Transfer cancelled", "AbortError");
        this.activeIndex = index;
        await this.#sendFile(index);
      }

      this.transport.sendControl({ t: CONTROL.COMPLETE, totalBytes: this.totalBytes });
      this.finished = true;
      this.activeIndex = -1;
      this.#emit(true);
      this.dispatchEvent(
        new CustomEvent("complete", {
          detail: {
            files: this.entries.length,
            bytes: this.sentBytes,
            detail: buildProgressDetail({
              entries: this.entries,
              transferredBytes: this.sentBytes,
              totalBytes: this.totalBytes,
              activeIndex: -1,
              speedMeter: this.speed,
              complete: true,
            }),
          },
        }),
      );
    } catch (error) {
      if (this.aborted) {
        this.dispatchEvent(new CustomEvent("cancelled", { detail: { reason: this.cancelReason } }));
      } else {
        this.dispatchEvent(
          new CustomEvent("error", {
            detail: { error, message: error?.message || "The transfer failed." },
          }),
        );
      }
    } finally {
      window.clearTimeout(this.emitTimer);
      this.emitTimer = 0;
      this.#emit(true);
    }
  }

  /** @param {number} index */
  async #sendFile(index) {
    const entry = this.entries[index];
    this.transport.sendControl(fileStartMessage(index, entry));
    this.#emit(true);

    const { file } = entry;
    let offset = 0;
    let sequence = 0;

    while (offset < entry.size) {
      if (this.aborted) throw new DOMException("Transfer cancelled", "AbortError");

      const blockEnd = Math.min(offset + this.readBlockSize, entry.size);
      const block = new Uint8Array(await file.slice(offset, blockEnd).arrayBuffer());
      let inner = 0;

      while (inner < block.byteLength) {
        if (this.aborted) throw new DOMException("Transfer cancelled", "AbortError");
        // Backpressure: never queue more than the high-water mark in the channel.
        await this.transport.waitForDrain({ signal: this.abortController.signal });

        const length = Math.min(this.chunkSize, block.byteLength - inner);
        const payload = block.subarray(inner, inner + length);
        this.transport.sendBinary(encodeChunk(index, sequence, payload));

        inner += length;
        offset += length;
        sequence += 1;
        this.sentBytes += length;
        entry.transferred = offset;
        this.speed.add(length);
        this.#emit();

        // Yield regularly so the UI and the WebRTC stack can breathe.
        if (sequence % 24 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    this.transport.sendControl(fileEndMessage(index, offset, sequence));
    this.dispatchEvent(
      new CustomEvent("file-complete", {
        detail: { index, id: entry.id, name: entry.name, size: entry.size },
      }),
    );
    this.#emit(true);
  }

  /** Coalesces progress events to ~8 per second. */
  #emit(force = false) {
    if (force) {
      window.clearTimeout(this.emitTimer);
      this.emitTimer = 0;
      this.lastEmitAt = performance.now();
      this.#dispatchProgress();
      return;
    }
    if (this.emitTimer) return;
    const elapsed = performance.now() - this.lastEmitAt;
    const delay = Math.max(0, 120 - elapsed);
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = 0;
      this.lastEmitAt = performance.now();
      this.#dispatchProgress();
    }, delay);
  }

  #dispatchProgress() {
    this.dispatchEvent(
      new CustomEvent("progress", {
        detail: buildProgressDetail({
          entries: this.entries,
          transferredBytes: this.sentBytes,
          totalBytes: this.totalBytes,
          activeIndex: this.activeIndex,
          speedMeter: this.speed,
        }),
      }),
    );
  }

  /**
   * Cancels the transfer locally and tells the peer.
   * @param {string} [reason]
   */
  cancel(reason = CANCEL_REASON.SENDER_CANCELLED) {
    if (this.aborted) return;
    this.aborted = true;
    this.cancelReason = reason;
    this.abortController.abort();
    try {
      if (this.transport.isOpen) this.transport.sendControl(cancelMessage(reason));
    } catch {
      /* best effort */
    }
  }

  dispose() {
    window.clearTimeout(this.emitTimer);
    this.emitTimer = 0;
    this.abortController.abort();
  }
}
