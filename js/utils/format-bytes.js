/** Human readable byte sizes and time/duration formatting. */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * @param {number} bytes
 * @param {{ decimals?: number, space?: boolean }} [options]
 */
export function formatBytes(bytes, options = {}) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
  const scaled = value / 1024 ** exponent;
  const decimals =
    options.decimals ?? (exponent === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2);
  const rounded = Number(scaled.toFixed(decimals));
  return `${rounded}${options.space === false ? "" : " "}${UNITS[exponent]}`;
}

/** Bytes per second -> "18.5 MB/s" (empty string until a rate is known). */
export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond, { decimals: bytesPerSecond >= 10 * 1024 ** 2 ? 0 : 1 })}/s`;
}

/** Seconds -> "00:42" / "1:04:12". Returns "—" when unknown. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60 * 60 * 24 * 7) return "—";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/** Countdown clock for room expiry, e.g. "9:59". */
export function formatCountdown(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** 0..1 -> integer percentage clamped to 0..100. */
export function toPercent(ratio) {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

/** File count label: "1 file" / "12 files". */
export function formatFileCount(count) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** Epoch milliseconds -> "just now" / "12 min ago" / "3 days ago". */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "never";
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.round(months / 12);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}
