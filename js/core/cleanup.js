/**
 * Disposal bookkeeping. Every resource created for a transfer (socket,
 * connection, channel, camera stream, object URLs, timers) goes into a scope so
 * a single call releases all of them — including on error paths.
 */

export class ResourceScope {
  constructor() {
    /** @type {Array<() => void>} */
    this.disposers = [];
    this.disposed = false;
  }

  /** @param {() => void} disposer */
  add(disposer) {
    if (typeof disposer !== "function") return disposer;
    if (this.disposed) {
      try {
        disposer();
      } catch {
        /* already disposing */
      }
      return disposer;
    }
    this.disposers.push(disposer);
    return disposer;
  }

  /** @param {MediaStream|null|undefined} stream */
  addStream(stream) {
    if (!stream) return;
    this.add(() => stopStream(stream));
  }

  /** @param {string} url */
  addObjectUrl(url) {
    if (!url) return;
    this.add(() => URL.revokeObjectURL(url));
  }

  /** @param {number} timerId @param {"timeout"|"interval"} kind */
  addTimer(timerId, kind = "timeout") {
    this.add(() => (kind === "interval" ? clearInterval(timerId) : clearTimeout(timerId)));
  }

  /** Runs every disposer in reverse order. Safe to call more than once. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    while (this.disposers.length) {
      const disposer = this.disposers.pop();
      try {
        disposer?.();
      } catch (error) {
        console.warn("[cleanup] disposer failed", error?.message);
      }
    }
  }
}

/** Stops every track in a media stream. */
export function stopStream(stream) {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* stream already ended */
  }
}
