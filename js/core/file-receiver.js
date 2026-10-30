/**
 * Reassembles files streamed over the data channel.
 *
 * The receiver never touches the network until the user explicitly accepts.
 * Every chunk is validated (order, bounds, length) and each file's byte count
 * is checked against the manifest before it is offered for download.
 */

import { config } from "../config.js";
import { SpeedMeter } from "../utils/speed-meter.js";
import {
  CONTROL,
  CANCEL_REASON,
  ProtocolError,
  cancelMessage,
  parseManifest,
} from "./transfer-protocol.js";
import { buildProgressDetail } from "./transfer-stats.js";

export class FileReceiver extends EventTarget {
  /** @param {{ transport: import("./data-channel.js").DataChannelTransport }} options */
  constructor({ transport }) {
    super();
    this.transport = transport;
    /** @type {"awaiting-manifest"|"awaiting-consent"|"receiving"|"complete"|"cancelled"|"failed"} */
    this.state = "awaiting-manifest";
    /** @type {Array<{id:string,name:string,size:number,type:string,parts:Uint8Array[],transferred:number,expectedSeq:number,blob?:Blob,url?:string}>} */
    this.entries = [];
    this.totalBytes = 0;
    this.receivedBytes = 0;
    this.activeIndex = -1;
    this.speed = new SpeedMeter();
    this.emitTimer = 0;
    this.lastEmitAt = 0;
    this.objectUrls = [];
  }

  /* ------------------------------------------------------------------------
     Incoming frames
     ------------------------------------------------------------------------ */

  /** @param {Record<string, unknown>} message */
  handleControl(message) {
    try {
      switch (message.t) {
        case CONTROL.MANIFEST:
          this.#handleManifest(message);
          break;
        case CONTROL.FILE_START:
          this.#handleFileStart(message);
          break;
        case CONTROL.FILE_END:
          this.#handleFileEnd(message);
          break;
        case CONTROL.COMPLETE:
          this.#handleComplete(message);
          break;
        case CONTROL.CANCEL:
          this.#handlePeerCancel(message);
          break;
        case CONTROL.ERROR:
          this.#fail(String(message.message || "The sender reported an error."));
          break;
        default:
          // accept/reject are sender-bound control messages in this direction.
          break;
      }
    } catch (error) {
      this.#fail(error?.message || "The transfer protocol failed.");
    }
  }

  /** @param {{ fileIndex: number, sequence: number, payload: Uint8Array }} chunk */
  handleChunk({ fileIndex, sequence, payload }) {
    if (this.state !== "receiving") {
      this.#fail("Received file data before the transfer was accepted.");
      return;
    }
    const entry = this.entries[fileIndex];
    if (!entry) {
      this.#fail("Received data for an unknown file.");
      return;
    }
    if (sequence !== entry.expectedSeq) {
      this.#fail("A file chunk arrived out of order.");
      return;
    }
    const nextSize = entry.transferred + payload.byteLength;
    if (nextSize > entry.size) {
      this.#fail("The sender sent more bytes than declared.");
      return;
    }
    if (this.receivedBytes + payload.byteLength > config.maxTotalBytes) {
      this.#fail("This transfer is larger than this browser can hold in memory.");
      return;
    }

    entry.parts.push(payload);
    entry.transferred = nextSize;
    entry.expectedSeq += 1;
    this.receivedBytes += payload.byteLength;
    this.activeIndex = fileIndex;
    this.speed.add(payload.byteLength);
    this.#emit();
  }

  #handleManifest(message) {
    if (this.state !== "awaiting-manifest") {
      throw new ProtocolError("The sender sent a second manifest.");
    }
    const { files, totalBytes } = parseManifest(message);
    this.entries = files.map((file) => ({
      ...file,
      parts: [],
      transferred: 0,
      expectedSeq: 0,
    }));
    this.totalBytes = totalBytes;
    this.state = "awaiting-consent";

    this.dispatchEvent(
      new CustomEvent("manifest", {
        detail: {
          files: files.map(({ id, name, size, type }) => ({ id, name, size, type })),
          totalBytes,
        },
      }),
    );
  }

  #handleFileStart(message) {
    if (this.state !== "receiving") {
      throw new ProtocolError("Received file data before the transfer was accepted.");
    }
    const index = Number(message.index);
    const entry = this.entries[index];
    if (!entry) throw new ProtocolError("Unknown file index.");
    if (entry.transferred !== 0 || entry.expectedSeq !== 0) {
      throw new ProtocolError("The sender restarted a file unexpectedly.");
    }
    this.activeIndex = index;
    this.dispatchEvent(
      new CustomEvent("file-start", { detail: { index, id: entry.id, name: entry.name } }),
    );
  }

  #handleFileEnd(message) {
    if (this.state !== "receiving") throw new ProtocolError("Unexpected file end.");
    const index = Number(message.index);
    const entry = this.entries[index];
    if (!entry) throw new ProtocolError("Unknown file index.");
    if (Number(message.bytes) !== entry.size || entry.transferred !== entry.size) {
      throw new ProtocolError("A file arrived incomplete.");
    }
    if (Number(message.chunks) !== entry.expectedSeq) {
      throw new ProtocolError("A file arrived with missing chunks.");
    }

    // Assemble the Blob once; the chunk buffers can then be released.
    const blob = new Blob(entry.parts, { type: entry.type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    entry.blob = blob;
    entry.url = url;
    entry.parts = [];

    this.dispatchEvent(
      new CustomEvent("file-complete", {
        detail: { index, id: entry.id, name: entry.name, size: entry.size, url },
      }),
    );
    this.#emit(true);
  }

  #handleComplete(message) {
    if (this.state !== "receiving") throw new ProtocolError("Unexpected completion message.");
    const declared = Number(message.totalBytes);
    const allDone = this.entries.every((entry) => entry.transferred === entry.size && entry.url);
    if (!allDone || this.receivedBytes !== this.totalBytes) {
      throw new ProtocolError("The transfer finished with missing data.");
    }
    if (Number.isFinite(declared) && declared !== this.totalBytes) {
      throw new ProtocolError("The sender's total does not match the received data.");
    }

    this.state = "complete";
    window.clearTimeout(this.emitTimer);
    this.emitTimer = 0;

    // Tell the sender the bytes were received and verified so it can show a
    // truthful completion state instead of guessing from its own send queue.
    try {
      this.transport.sendControl({ t: CONTROL.CONFIRMED, totalBytes: this.receivedBytes });
    } catch {
      /* the sender may already be gone; the room close still cleans up */
    }
    this.dispatchEvent(
      new CustomEvent("complete", {
        detail: {
          files: this.entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            size: entry.size,
            type: entry.type,
            url: entry.url,
            blob: entry.blob,
          })),
          totalBytes: this.totalBytes,
          elapsed: this.speed.elapsedSeconds(),
          detail: buildProgressDetail({
            entries: this.entries,
            transferredBytes: this.receivedBytes,
            totalBytes: this.totalBytes,
            activeIndex: -1,
            speedMeter: this.speed,
            complete: true,
          }),
        },
      }),
    );
  }

  #handlePeerCancel(message) {
    this.state = "cancelled";
    this.dispatchEvent(
      new CustomEvent("cancelled", {
        detail: { reason: String(message.reason ?? CANCEL_REASON.SENDER_CANCELLED) },
      }),
    );
  }

  /* ------------------------------------------------------------------------
     User decisions
     ------------------------------------------------------------------------ */

  /** Receiver consent: the only place that unblocks file bytes. */
  accept() {
    if (this.state !== "awaiting-consent") throw new Error("There is nothing to accept.");
    this.state = "receiving";
    this.speed.reset();
    this.transport.sendControl({ t: CONTROL.ACCEPT });
    this.#emit(true);
  }

  /** @param {string} [reason] */
  reject(reason = CANCEL_REASON.RECEIVER_REJECTED) {
    if (this.state !== "awaiting-consent") return;
    this.state = "cancelled";
    try {
      this.transport.sendControl({ t: CONTROL.REJECT, reason });
    } catch {
      /* best effort */
    }
    this.dispatchEvent(new CustomEvent("rejected", { detail: { reason } }));
  }

  /** User-initiated cancel while receiving. */
  cancel(reason = CANCEL_REASON.RECEIVER_CANCELLED) {
    if (this.state === "complete" || this.state === "cancelled") return;
    this.state = "cancelled";
    try {
      if (this.transport.isOpen) this.transport.sendControl(cancelMessage(reason));
    } catch {
      /* best effort */
    }
    this.dispatchEvent(new CustomEvent("cancelled", { detail: { reason } }));
  }

  #fail(message) {
    if (this.state === "failed" || this.state === "complete") return;
    this.state = "failed";
    try {
      if (this.transport.isOpen) {
        this.transport.sendControl({ t: CONTROL.ERROR, message: String(message).slice(0, 200) });
      }
    } catch {
      /* best effort */
    }
    this.dispatchEvent(new CustomEvent("error", { detail: { message } }));
  }

  /* ------------------------------------------------------------------------
     Progress
     ------------------------------------------------------------------------ */

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
          transferredBytes: this.receivedBytes,
          totalBytes: this.totalBytes,
          activeIndex: this.activeIndex,
          speedMeter: this.speed,
        }),
      }),
    );
  }

  /** Revokes object URLs created for the received files. */
  dispose() {
    window.clearTimeout(this.emitTimer);
    this.emitTimer = 0;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }
}
