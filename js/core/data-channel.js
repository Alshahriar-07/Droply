/**
 * Thin, event-driven wrapper around an RTCDataChannel.
 *
 * Responsibilities:
 *  - parse control (text) and chunk (binary) frames
 *  - expose promise-based backpressure so the sender never grows an unbounded
 *    write queue
 *  - surface open/close/error as events the UI can trust
 */

import { config } from "../config.js";
import { decodeChunk, parseControl, ProtocolError } from "./transfer-protocol.js";

export class DataChannelTransport extends EventTarget {
  /** @param {RTCDataChannel} channel */
  constructor(channel) {
    super();
    this.channel = channel;
    this.channel.binaryType = "arraybuffer";
    this.channel.bufferedAmountLowThreshold = config.lowWaterMark;
    this.opened = channel.readyState === "open";
    this.closedByUs = false;
    this.failure = null;

    this.channel.addEventListener("open", () => {
      this.opened = true;
      this.dispatchEvent(new Event("open"));
    });

    this.channel.addEventListener("close", () => {
      this.opened = false;
      this.dispatchEvent(new CustomEvent("close", { detail: { byUs: this.closedByUs } }));
    });

    this.channel.addEventListener("error", (event) => {
      this.failure = event?.error ?? new Error("Data channel error");
      this.dispatchEvent(new CustomEvent("error", { detail: { error: this.failure } }));
    });

    this.channel.addEventListener("message", (event) => this.#handleMessage(event.data));
  }

  get label() {
    return this.channel.label;
  }

  get isOpen() {
    return this.channel.readyState === "open";
  }

  get bufferedAmount() {
    return this.channel.bufferedAmount;
  }

  #handleMessage(data) {
    try {
      if (typeof data === "string") {
        this.dispatchEvent(new CustomEvent("control", { detail: parseControl(data) }));
      } else if (data instanceof ArrayBuffer) {
        this.dispatchEvent(new CustomEvent("chunk", { detail: decodeChunk(data) }));
      } else if (ArrayBuffer.isView(data)) {
        const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        this.dispatchEvent(new CustomEvent("chunk", { detail: decodeChunk(copy) }));
      } else {
        throw new ProtocolError("Unsupported message payload.");
      }
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent("protocolerror", { detail: { error, message: error?.message } }),
      );
    }
  }

  /** Resolves when the channel is open (immediately if it already is). */
  whenOpen(timeoutMs = 15_000) {
    if (this.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("The data channel did not open in time."));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("The data channel closed before it opened."));
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        this.removeEventListener("open", onOpen);
        this.removeEventListener("close", onClose);
      };
      this.addEventListener("open", onOpen);
      this.addEventListener("close", onClose);
    });
  }

  /**
   * @param {Record<string, unknown>} message
   */
  sendControl(message) {
    if (!this.isOpen) throw new Error("Cannot send: the data channel is closed.");
    this.channel.send(JSON.stringify({ ...message, v: 1 }));
  }

  /**
   * @param {ArrayBuffer} buffer
   */
  sendBinary(buffer) {
    if (!this.isOpen) throw new Error("Cannot send: the data channel is closed.");
    if (this.channel.bufferedAmount > 16 * 1024 * 1024) {
      throw new Error("The data channel buffer is full.");
    }
    this.channel.send(buffer);
  }

  /**
   * Waits until the outgoing buffer drains below the low-water mark.
   * Uses `bufferedamountlow` with a polling fallback because some engines
   * skip the event when several large writes are queued at once.
   * @param {{ signal?: AbortSignal }} [options]
   */
  waitForDrain(options = {}) {
    const channel = this.channel;
    if (!this.isOpen) return Promise.reject(new Error("The data channel closed."));
    if (channel.bufferedAmount <= config.highWaterMark) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        window.clearInterval(poll);
        channel.removeEventListener("bufferedamountlow", check);
        channel.removeEventListener("close", onClose);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const fail = (message) => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(message));
      };
      const check = () => {
        if (channel.readyState !== "open") return fail("The data channel closed.");
        if (channel.bufferedAmount <= config.lowWaterMark) finish();
      };
      const onClose = () => fail("The data channel closed.");
      const onAbort = () => fail("Transfer cancelled.");

      channel.addEventListener("bufferedamountlow", check);
      channel.addEventListener("close", onClose);
      options.signal?.addEventListener("abort", onAbort);
      const poll = window.setInterval(check, 50);
      check();
    });
  }

  /**
   * Closes the channel. Safe to call repeatedly.
   * @param {string} [reason]
   */
  close(reason = "done") {
    this.closedByUs = true;
    try {
      if (this.channel.readyState !== "closed") this.channel.close();
    } catch {
      /* already gone */
    }
    this.opened = false;
    void reason;
  }
}
