/**
 * Persistent device identity for Saved Devices.
 *
 * Two key pairs are created once per browser profile:
 *   - ECDSA P-256 for signing transfer invites (proves "this is the device you
 *     paired with", so a saved device name can never be spoofed on the relay)
 *   - ECDH P-256 for the short authentication string shown during pairing
 *
 * Private keys are imported as NON-EXTRACTABLE CryptoKeys and stored in
 * IndexedDB. There is no code path that can export them: only the public JWK
 * is ever serialised, transmitted or displayed.
 */

import { base64UrlEncode, bytesToHex } from "../utils/encoding.js";
import {
  buildDeviceName,
  cleanDeviceLabel,
  cleanDeviceName,
  detectDeviceEnvironment,
  randomDeviceSuffix,
  sanitizeAvatarId,
} from "./device-profile.js";

const IDENTITY_KEY = "device.identity.v1";
const SIGN_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" };
const AGREE_ALGORITHM = { name: "ECDH", namedCurve: "P-256" };
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Environment defaults, including the model label (never a guessed model). */
export function describeDevice() {
  return detectDeviceEnvironment();
}

/** Stable id derived from the signing key, so an id can never be forged. */
export async function deviceIdFromPublicJwk(publicJwk) {
  const key = await crypto.subtle.importKey("jwk", publicJwk, SIGN_ALGORITHM, true, ["verify"]);
  const spki = await crypto.subtle.exportKey("spki", key);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  return base64UrlEncode(new Uint8Array(digest).slice(0, 16));
}

export function isValidDeviceId(value) {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

/**
 * WebCrypto returns ECDSA signatures as raw r||s on some engines and DER on
 * others. Normalising to raw 64 bytes keeps signatures readable across
 * browsers; verification still accepts either form.
 */
function derToRaw(signature) {
  if (!signature || signature.length === 64) return signature ?? null;
  if (signature[0] !== 0x30) return null;
  let offset = 2;
  if (signature[1] & 0x80) offset = 2 + (signature[1] & 0x7f);
  if (signature[offset] !== 0x02) return null;
  const rLength = signature[offset + 1];
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  const sOffset = offset + 2 + rLength;
  if (signature[sOffset] !== 0x02) return null;
  const sLength = signature[sOffset + 1];
  const s = signature.slice(sOffset + 2, sOffset + 2 + sLength);
  const out = new Uint8Array(64);
  out.set(r.slice(-32), 32 - Math.min(32, r.length));
  out.set(s.slice(-32), 32 - Math.min(32, s.length) + 32);
  return out;
}

function rawToDer(raw) {
  const trim = (bytes) => {
    let index = 0;
    while (index < bytes.length - 1 && bytes[index] === 0) index += 1;
    let slice = bytes.slice(index);
    if (slice[0] & 0x80) slice = Uint8Array.from([0, ...slice]);
    return slice;
  };
  const r = trim(raw.slice(0, 32));
  const s = trim(raw.slice(32));
  return Uint8Array.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

/** Creates (or loads) this browser's device identity. */
export async function loadDeviceIdentity({ store, rename } = {}) {
  if (!store) throw new Error("A storage adapter is required for the device identity.");

  const stored = await store.get(IDENTITY_KEY);
  if (stored?.privateKey && stored?.agreementPrivateKey && stored?.publicJwk) {
    const publicKey = await crypto.subtle.importKey("jwk", stored.publicJwk, SIGN_ALGORITHM, true, [
      "verify",
    ]);
    const agreementPublicKey = await crypto.subtle.importKey(
      "jwk",
      stored.agreementPublicJwk,
      AGREE_ALGORITHM,
      true,
      [],
    );

    // Older records predate the profile fields. They get a suffix once and
    // the upgraded record is written back, so a reload cannot renumber them.
    const environment = detectDeviceEnvironment();
    const hasSuffix = /^\d{4}$/.test(String(stored.suffix ?? ""));
    const suffix = hasSuffix ? String(stored.suffix) : randomDeviceSuffix();
    const avatar = stored.avatar ? sanitizeAvatarId(stored.avatar) : environment.avatar;
    const defaultName = buildDeviceName(environment.modelLabel, suffix);
    const storedName = String(stored.name ?? "").trim().slice(0, 40);
    const name = rename
      ? cleanDeviceName(rename, storedName || defaultName)
      : hasSuffix
        ? storedName || defaultName
        : defaultName;
    const profile = {
      suffix,
      avatar,
      deviceType: cleanDeviceLabel(stored.deviceType, environment.deviceType),
      platform: cleanDeviceLabel(stored.platform, environment.platform),
      browser: cleanDeviceLabel(stored.browser, environment.browser),
      model: stored.model ? cleanDeviceLabel(stored.model) : environment.model,
    };

    if (!hasSuffix || !stored.avatar || !stored.platform || name !== stored.name) {
      await store.set(IDENTITY_KEY, {
        ...stored,
        name,
        ...profile,
        updatedAt: Date.now(),
      });
    }

    return buildIdentity({
      deviceId: stored.deviceId,
      name,
      ...profile,
      publicJwk: stored.publicJwk,
      agreementPublicJwk: stored.agreementPublicJwk,
      signingKey: stored.privateKey,
      publicKey,
      agreementKey: stored.agreementPrivateKey,
      agreementPublicKey,
      store,
      createdAt: stored.createdAt,
      environment,
    });
  }

  const environment = detectDeviceEnvironment();
  const suffix = randomDeviceSuffix();
  const signing = await generateSigningPair();
  const agreement = await generateAgreementPair();
  const deviceId = await deviceIdFromPublicJwk(signing.publicJwk);
  const record = {
    deviceId,
    name: rename
      ? cleanDeviceName(rename, buildDeviceName(environment.modelLabel, suffix))
      : buildDeviceName(environment.modelLabel, suffix),
    suffix,
    avatar: environment.avatar,
    deviceType: environment.deviceType,
    platform: environment.platform,
    browser: environment.browser,
    model: environment.model,
    publicJwk: signing.publicJwk,
    agreementPublicJwk: agreement.publicJwk,
    privateKey: signing.privateKey,
    agreementPrivateKey: agreement.privateKey,
    createdAt: Date.now(),
  };
  await store.set(IDENTITY_KEY, record);

  return buildIdentity({
    deviceId,
    name: record.name,
    suffix: record.suffix,
    avatar: record.avatar,
    deviceType: record.deviceType,
    platform: record.platform,
    browser: record.browser,
    model: record.model,
    publicJwk: signing.publicJwk,
    agreementPublicJwk: agreement.publicJwk,
    signingKey: signing.privateKey,
    publicKey: signing.publicKey,
    agreementKey: agreement.privateKey,
    agreementPublicKey: agreement.publicKey,
    store,
    createdAt: record.createdAt,
    environment,
  });
}

async function generateSigningPair() {
  const temporary = await crypto.subtle.generateKey(SIGN_ALGORITHM, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", temporary.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", temporary.publicKey);
  // Re-import so the stored private key can never be exported again.
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, SIGN_ALGORITHM, false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, SIGN_ALGORITHM, true, ["verify"]);
  return { privateKey, publicKey, publicJwk: { ...publicJwk, key_ops: ["verify"], ext: true } };
}

async function generateAgreementPair() {
  const temporary = await crypto.subtle.generateKey(AGREE_ALGORITHM, true, ["deriveBits"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", temporary.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", temporary.publicKey);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, AGREE_ALGORITHM, false, [
    "deriveBits",
  ]);
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, AGREE_ALGORITHM, true, []);
  return { privateKey, publicKey, publicJwk: { ...publicJwk, key_ops: [], ext: true } };
}

function buildIdentity(spec) {
  const environment = spec.environment ?? detectDeviceEnvironment();

  /** Writes only the public profile fields, leaving the key material alone. */
  async function writeProfile(patch) {
    const record = await spec.store.get(IDENTITY_KEY);
    if (record) await spec.store.set(IDENTITY_KEY, { ...record, ...patch, updatedAt: Date.now() });
  }

  const identity = {
    deviceId: spec.deviceId,
    name: spec.name,
    deviceType: spec.deviceType,
    platform: spec.platform,
    browser: spec.browser,
    model: spec.model ?? null,
    avatar: spec.avatar,
    suffix: spec.suffix,
    publicJwk: spec.publicJwk,
    agreementPublicJwk: spec.agreementPublicJwk,
    createdAt: spec.createdAt ?? Date.now(),
    signingKey: spec.signingKey,
    publicKey: spec.publicKey,
    agreementKey: spec.agreementKey,
    agreementPublicKey: spec.agreementPublicKey,

    /** The public profile, exactly as peers receive it. */
    get profile() {
      return {
        deviceId: identity.deviceId,
        name: identity.name,
        deviceType: identity.deviceType,
        platform: identity.platform,
        browser: identity.browser,
        model: identity.model,
        avatar: identity.avatar,
        suffix: identity.suffix,
      };
    },

    /** Signs UTF-8 text and returns a base64url raw r||s signature. */
    async sign(text) {
      const signature = await crypto.subtle.sign(SIGN_PARAMS, spec.signingKey, new TextEncoder().encode(text));
      const bytes = new Uint8Array(signature);
      // A raw signature is exactly 64 bytes; only longer output can be DER.
      // Sniffing the first byte would misread the ~1 in 256 raw signatures
      // whose high byte happens to be 0x30.
      const raw = bytes.length === 64 ? bytes : derToRaw(bytes);
      if (!raw) throw new Error("The browser produced an unusable signature.");
      return base64UrlEncode(raw);
    },

    /** True when `signature` (base64url, raw or DER) matches the text. */
    async verify(publicKeyJwk, text, signature) {
      const key = await crypto.subtle.importKey("jwk", publicKeyJwk, SIGN_ALGORITHM, true, ["verify"]);
      return verifySignature(key, text, signature);
    },

    /** Renames this device (the display name peers see). */
    async rename(nextName) {
      // Bounded exactly like the original API: trim and clamp, without
      // rewriting the user's spacing.
      const clean = String(nextName ?? "").trim().slice(0, 40);
      if (!clean) throw new Error("Choose a device name.");
      identity.name = clean;
      await writeProfile({ name: clean });
      return clean;
    },

    /** Selects one of the bundled device avatars. */
    async setAvatar(nextAvatar) {
      const avatar = sanitizeAvatarId(nextAvatar);
      identity.avatar = avatar;
      await writeProfile({ avatar });
      return avatar;
    },

    /**
     * Issues a new 4-digit discriminator and restores the generated name.
     * The signing and agreement keys (and therefore the device id and all
     * saved-device authorisations) are deliberately left untouched.
     */
    async regenerateSuffix() {
      const suffix = randomDeviceSuffix();
      const name = buildDeviceName(environment.modelLabel, suffix);
      identity.suffix = suffix;
      identity.name = name;
      await writeProfile({ suffix, name });
      return suffix;
    },

    /** Applies a profile edit in one storage write. */
    async updateProfile({ name, avatar, regenerateSuffix: regenerate = false } = {}) {
      const patch = {};
      if (regenerate) {
        patch.suffix = randomDeviceSuffix();
        patch.name = buildDeviceName(environment.modelLabel, patch.suffix);
      } else if (name !== undefined) {
        const clean = cleanDeviceName(name);
        if (!clean) throw new Error("Choose a device name.");
        patch.name = clean;
      }
      if (avatar !== undefined) patch.avatar = sanitizeAvatarId(avatar);
      if (!Object.keys(patch).length) return identity;
      Object.assign(identity, patch);
      await writeProfile(patch);
      return identity;
    },

    /** Short, stable, non-secret fingerprint for the UI. */
    get fingerprint() {
      return bytesToHex(base64UrlDecodeSafe(spec.deviceId)).slice(0, 12).toUpperCase();
    },
  };
  return identity;
}

function base64UrlDecodeSafe(value) {
  try {
    const normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Verifies a base64url signature over UTF-8 text. Accepts either an imported
 * ECDSA public CryptoKey or a stored public JWK.
 */
export async function verifySignature(publicKeyOrJwk, text, signature) {
  let key;
  try {
    key =
      publicKeyOrJwk?.type === "public"
        ? publicKeyOrJwk
        : await crypto.subtle.importKey("jwk", publicKeyOrJwk, SIGN_ALGORITHM, true, ["verify"]);
  } catch {
    return false;
  }

  let bytes;
  try {
    const normalized = String(signature ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return false;
  }
  const data = new TextEncoder().encode(String(text ?? ""));
  const candidates = [];
  if (bytes.length === 64) {
    candidates.push(bytes, rawToDer(bytes));
  } else {
    const raw = derToRaw(bytes);
    if (raw) candidates.push(raw, bytes);
  }
  for (const candidate of candidates) {
    try {
      if (await crypto.subtle.verify(SIGN_PARAMS, key, candidate, data)) return true;
    } catch {
      /* try the next encoding */
    }
  }
  return false;
}
