/**
 * Rolling-window throughput meter used by both sides of a transfer.
 * Reports a smoothed rate so the UI does not flicker on every chunk.
 */
export class SpeedMeter {
  /** @param {{ windowMs?: number, minSamples?: number }} [options] */
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 2500;
    this.minSamples = options.minSamples ?? 3;
    /** @type {Array<{ t: number, bytes: number }>} */
    this.samples = [];
    this.startedAt = 0;
    this.bytes = 0;
    this.smoothed = 0;
  }

  reset() {
    this.samples = [];
    this.startedAt = 0;
    this.bytes = 0;
    this.smoothed = 0;
  }

  /** @param {number} bytes */
  add(bytes, now = performance.now()) {
    if (!this.startedAt) this.startedAt = now;
    this.bytes += bytes;
    this.samples.push({ t: now, bytes: this.bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
    this.#update(now);
  }

  #update(now) {
    if (this.samples.length < 2) return;
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    if (dt <= 0.15) return;
    const instant = (this.bytes - first.bytes) / dt;
    // Exponential smoothing keeps the number readable while staying honest.
    this.smoothed = this.smoothed ? this.smoothed * 0.72 + instant * 0.28 : instant;
  }

  /** Bytes per second, or 0 while there is not enough signal. */
  rate(now = performance.now()) {
    this.#update(now);
    return this.samples.length >= this.minSamples ? Math.max(0, this.smoothed) : 0;
  }

  /** Seconds remaining for `remainingBytes`, or null when unknown. */
  eta(remainingBytes) {
    const rate = this.rate();
    if (!rate || remainingBytes <= 0) return null;
    return remainingBytes / rate;
  }

  /** Average rate since the first byte (used once a transfer completes). */
  averageRate() {
    if (!this.startedAt) return 0;
    const seconds = (performance.now() - this.startedAt) / 1000;
    return seconds > 0.2 ? this.bytes / seconds : 0;
  }

  elapsedSeconds() {
    if (!this.startedAt) return 0;
    return (performance.now() - this.startedAt) / 1000;
  }
}
