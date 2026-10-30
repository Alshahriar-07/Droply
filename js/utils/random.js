/**
 * Cryptographically secure random helpers.
 * Room codes are issued by the signaling server; these helpers exist for
 * client-side identifiers and for tests.
 */

/** Unambiguous alphabet: no O/0 or I/1. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** @returns {Uint8Array} */
function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Random code from the unambiguous alphabet.
 * Uses rejection sampling so every character is uniformly distributed.
 * @param {number} [length]
 */
export function randomCode(length = 6) {
  const out = [];
  const max = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue;
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

/** URL-safe random identifier, e.g. for transfer session ids. */
export function randomId(byteLength = 12) {
  const bytes = randomBytes(byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-ish comparison for short user input (not a security primitive). */
export function codesEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
