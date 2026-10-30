/** Input validation and sanitising shared by the UI and the transfer engine. */

import { config } from "../config.js";
import { formatBytes } from "./format-bytes.js";

/** Same alphabet the signaling server issues: no O/0 or I/1. */
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/**
 * Normalises human input: uppercase, strips spaces/hyphens and other noise.
 * @param {string} value
 */
export function normalizeCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

/** @param {string} value */
export function isValidCode(value) {
  return CODE_PATTERN.test(value);
}

/**
 * Pulls a room code out of a scanned QR payload or a deep link.
 * Accepts plain codes, `#/receive?code=XXXXXX` links and `?code=XXXXXX` links.
 * @param {string} text
 * @returns {string|null}
 */
export function extractRoomCode(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const direct = normalizeCode(raw);
  if (isValidCode(direct) && raw.replace(/[^A-Za-z0-9]/g, "").length === 6) return direct;

  const match = raw.match(/[?&]code=([A-Za-z0-9]{1,12})/) || raw.match(/code[:=\s]+([A-Za-z0-9]{6})/i);
  if (match) {
    const candidate = normalizeCode(match[1]);
    if (isValidCode(candidate)) return candidate;
  }

  try {
    const url = new URL(raw);
    const fromQuery = normalizeCode(url.searchParams.get("code") ?? "");
    if (isValidCode(fromQuery)) return fromQuery;
  } catch {
    /* not a URL */
  }

  const fromHash = raw.match(/#.*[?&]code=([A-Za-z0-9]{6})/);
  if (fromHash) {
    const candidate = normalizeCode(fromHash[1]);
    if (isValidCode(candidate)) return candidate;
  }
  return null;
}

/** Display helper: "A7K9P2" stays as-is, empty becomes a placeholder. */
export function displayCode(value) {
  return isValidCode(value) ? value : "······";
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RESERVED_NAMES = new Set([".", "..", ""]);
/** Characters that are unsafe or illegal in downloaded filenames. */
const UNSAFE_NAME_CHARS = /[<>:"/\\|?*]/g;

/**
 * Makes a remote filename safe to display and to save.
 * Never used as HTML; only ever assigned via textContent or File APIs.
 * @param {unknown} name
 * @param {string} [fallback]
 */
export function sanitizeFileName(name, fallback = "file") {
  let clean = String(name ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(UNSAFE_NAME_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim();

  // Drop any path components a malicious sender may have included.
  const segments = clean.split(/[/\\]/).filter((segment) => !RESERVED_NAMES.has(segment));
  clean = segments.join("_") || "";

  if (!clean || RESERVED_NAMES.has(clean)) return fallback;
  if (clean.length <= 180) return clean;

  const dot = clean.lastIndexOf(".");
  if (dot > 0 && clean.length - dot <= 12) {
    return `${clean.slice(0, 180 - (clean.length - dot))}${clean.slice(dot)}`;
  }
  return clean.slice(0, 180);
}

/** A MIME type we are willing to forward, or "" when unknown. */
export function sanitizeMimeType(type) {
  const value = String(type ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(value)
    ? value
    : "";
}

/** @param {unknown} value */
export function isProbablySdp(value) {
  return typeof value === "string" && value.length >= 16 && value.startsWith("v=0");
}

/** Validates an ICE candidate object coming from the signaling channel. */
export function sanitizeIceCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const { candidate: line, sdpMid, sdpMLineIndex, usernameFragment } = candidate;
  if (typeof line !== "string" || line.length > 2048) return null;
  return {
    candidate: line,
    sdpMid: typeof sdpMid === "string" ? sdpMid.slice(0, 64) : null,
    sdpMLineIndex: Number.isInteger(sdpMLineIndex) ? sdpMLineIndex : null,
    usernameFragment:
      typeof usernameFragment === "string" ? usernameFragment.slice(0, 256) : undefined,
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validates a receiver-side manifest. Throws an Error with a user-safe
 * message when anything looks wrong; never trusts remote metadata.
 * @param {unknown} rawFiles
 * @returns {{ files: Array<{ id: string, name: string, size: number, type: string }>, totalBytes: number }}
 */
export function validateManifestFiles(rawFiles) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error("The sender did not provide any files.");
  }
  if (rawFiles.length > config.maxFiles) {
    throw new Error(`This transfer contains more than ${config.maxFiles} files.`);
  }

  let totalBytes = 0;
  const seen = new Set();
  const files = rawFiles.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("The transfer manifest is malformed.");
    }
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0 || size > config.maxFileBytes) {
      throw new Error(`A file in this transfer is larger than the ${formatBytes(config.maxFileBytes, { decimals: 0 })} limit.`);
    }
    const id = String(entry.id ?? index).slice(0, 24);
    if (!/^[a-z0-9-]{1,24}$/i.test(id)) {
      throw new Error("The transfer manifest is malformed.");
    }
    if (seen.has(id)) throw new Error("The transfer manifest contains duplicate files.");
    seen.add(id);
    totalBytes += size;
    return {
      id,
      name: sanitizeFileName(entry.name, `file-${index + 1}`),
      size: Math.round(size),
      type: sanitizeMimeType(entry.type),
    };
  });

  if (totalBytes > config.maxTotalBytes) {
    throw new Error(`This transfer is larger than the ${formatBytes(config.maxTotalBytes, { decimals: 0 })} limit.`);
  }

  return { files, totalBytes };
}

/**
 * A validation failure that can point at a catalog entry. `code` is the
 * catalog id the UI should render; `message` stays useful on its own.
 */
export class FileValidationError extends Error {
  constructor(message, code = "file/too-large") {
    super(message);
    this.name = "FileValidationError";
    this.code = code;
  }
}

/** Blocks transfers the local browser cannot reasonably handle. */
export function assertLocalFilesAreSendable(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new FileValidationError("Choose at least one file to send.", "file/none-selected");
  }
  if (files.length > config.maxFiles) {
    throw new FileValidationError(`You can send up to ${config.maxFiles} files at once.`);
  }
  let total = 0;
  for (const file of files) {
    if (file.size > config.maxFileBytes) {
      throw new FileValidationError(
        `"${sanitizeFileName(file.name)}" is larger than the ${formatBytes(config.maxFileBytes, { decimals: 0 })} per-file limit.`,
      );
    }
    total += file.size;
  }
  if (total > config.maxTotalBytes) {
    throw new FileValidationError(
      `The selection is larger than the ${formatBytes(config.maxTotalBytes, { decimals: 0 })} per-transfer limit.`,
    );
  }
  return total;
}
