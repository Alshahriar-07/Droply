/** Byte/string encoding helpers shared by the identity and pairing modules. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {string} text */
export function utf8ToBytes(text) {
  return encoder.encode(text);
}

/** @param {ArrayBuffer|Uint8Array} bytes */
export function bytesToUtf8(bytes) {
  return decoder.decode(bytes);
}

/**
 * URL-safe base64 without padding, which keeps QR payloads short and safe to
 * put in a link or a text field.
 * @param {ArrayBuffer|Uint8Array} bytes
 */
export function base64UrlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} value @returns {Uint8Array} */
export function base64UrlDecode(value) {
  const normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** @param {ArrayBuffer|Uint8Array} bytes */
export function bytesToHex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** JSON -> base64url text. Used for QR payloads. */
export function encodeJson(value) {
  return base64UrlEncode(utf8ToBytes(JSON.stringify(value)));
}

/** @param {string} text */
export function decodeJson(text) {
  return JSON.parse(bytesToUtf8(base64UrlDecode(text)));
}
