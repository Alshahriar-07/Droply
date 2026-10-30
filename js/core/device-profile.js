/**
 * Device profile: what this browser calls itself, everywhere in Droply.
 *
 * One profile is created per browser installation and never regenerated on a
 * reload. It carries a public display name (`Windows-3141`), a coarse device
 * category, platform, browser and an avatar id. The four-digit suffix is a
 * display discriminator only: it is never an authentication credential, and
 * the durable pairing credential remains the ECDSA key in device-identity.js.
 *
 * Detection is deliberately conservative. Browsers expose the operating system
 * and browser reliably, an Android model sometimes, and an exact iPhone or Mac
 * model essentially never. When a model cannot be read we fall back to the
 * platform name instead of inventing hardware.
 */

/** Every avatar the UI can render. Ids are stable and safe to persist. */
export const AVATARS = Object.freeze([
  { id: "windows", label: "Windows PC", icon: "monitor", tone: "windows" },
  { id: "mac", label: "Mac", icon: "monitor", tone: "apple" },
  { id: "macbook", label: "MacBook", icon: "laptop", tone: "apple" },
  { id: "linux", label: "Linux PC", icon: "monitor", tone: "linux" },
  { id: "desktop", label: "Desktop", icon: "monitor", tone: "neutral" },
  { id: "laptop", label: "Laptop", icon: "laptop", tone: "neutral" },
  { id: "android", label: "Android", icon: "smartphone", tone: "android" },
  { id: "iphone", label: "iPhone", icon: "smartphone", tone: "apple" },
  { id: "mobile", label: "Mobile", icon: "smartphone", tone: "neutral" },
  { id: "tablet", label: "Tablet", icon: "tablet", tone: "neutral" },
  { id: "generic", label: "Device", icon: "monitor", tone: "neutral" },
]);

export const AVATAR_IDS = Object.freeze(AVATARS.map((avatar) => avatar.id));
export const DEFAULT_AVATAR = "generic";

/** Categories the rest of the app displays. */
export const DEVICE_CATEGORIES = Object.freeze(["Desktop", "Laptop", "Tablet", "Mobile"]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const NAME_LIMIT = 40;
const LABEL_LIMIT = 24;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Strips control characters, collapses whitespace and clamps a public name. */
export function cleanDeviceName(value, fallback = "") {
  const clean = String(value ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_LIMIT);
  return clean || fallback;
}

/** A short public label (platform, browser, category). */
export function cleanDeviceLabel(value, fallback = "") {
  return String(value ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_LIMIT) || fallback;
}

export function sanitizeAvatarId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return AVATAR_IDS.includes(id) ? id : DEFAULT_AVATAR;
}

/**
 * Cryptographically secure 4-digit suffix (1000–9999). Rejection sampling
 * keeps the distribution uniform instead of biasing it with a plain modulo.
 */
export function randomDeviceSuffix() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("This browser cannot generate a secure device identifier.");
  }
  const buffer = new Uint32Array(1);
  const range = 9000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  do {
    cryptoApi.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return String(1000 + (buffer[0] % range));
}

/** `Windows` + `3141` -> `Windows-3141`. */
export function buildDeviceName(label, suffix) {
  const base = cleanDeviceLabel(label, "Device").replace(/\s+/g, "");
  const digits = String(suffix ?? "").replace(/\D/g, "").slice(0, 4);
  return `${base || "Device"}-${digits.padStart(4, "0")}`.slice(0, NAME_LIMIT);
}

/* --------------------------------------------------------------------------
   Environment detection
   -------------------------------------------------------------------------- */

const MOBILE_HINT = /mobile|iphone|ipod|android.*mobile|windows phone/i;

function readNavigator(nav) {
  if (nav) return nav;
  return typeof navigator !== "undefined" ? navigator : {};
}

/** Browser name, never a version or a fingerprint. */
export function detectBrowser(userAgent = "") {
  const ua = String(userAgent);
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/SamsungBrowser\//i.test(ua)) return "Samsung Internet";
  if (/Firefox\//i.test(ua) || /FxiOS\//i.test(ua)) return "Firefox";
  if (/CriOS\//i.test(ua) || /Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  return "Browser";
}

/**
 * Android model from the UA, when it looks like a real model. Generic tokens
 * such as "K", "wv" or "Mobile" are rejected rather than shown as hardware.
 */
export function androidModelFromUserAgent(userAgent = "") {
  const match = String(userAgent).match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build[/;]|\s*\))/i);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw || raw.length > 32) return null;
  if (/^(k|wv|mobile|tablet|linux|android|unknown|generic)$/i.test(raw)) return null;
  if (!/[a-z]/i.test(raw)) return null;
  if (!/^[A-Za-z0-9 ._+-]+$/.test(raw)) return null;
  return raw;
}

/** `OPPO A5x` -> `OppoA5x`; `SM-S711B` is left intact. */
export function formatModelLabel(model) {
  if (!model) return "";
  const tokens = String(model).trim().split(/\s+/).filter(Boolean);
  const humanized = tokens.map((token) => {
    if (token.length > 2 && !token.includes("-") && /^[A-Z0-9]+$/.test(token)) {
      return token[0] + token.slice(1).toLowerCase();
    }
    return token;
  });
  return humanized
    .join("")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, LABEL_LIMIT);
}

const PLATFORM_LABELS = {
  Windows: "Windows",
  macOS: "Mac",
  Linux: "Linux",
  ChromeOS: "Chromebook",
  Android: "Android",
  iOS: "iPhone",
  iPadOS: "iPad",
  Unknown: "Device",
};

/** @param {Navigator|object} [nav] */
export function detectDeviceEnvironment(nav) {
  const source = readNavigator(nav);
  const ua = String(source.userAgent ?? "");
  const uaDataPlatform = String(source.userAgentData?.platform ?? "");
  const platformHint = `${uaDataPlatform} ${source.platform ?? ""}`;
  const touchPoints = Number(source.maxTouchPoints) || 0;

  const isIPad = /ipad/i.test(ua) || (/macintosh/i.test(ua) && touchPoints > 1);
  const isIPhone = /iphone|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  const isChromeOS = /cros/i.test(ua) || /chrome os/i.test(uaDataPlatform);
  const isWindows = /windows|win32|win64/i.test(platformHint) || /windows/i.test(ua);
  const isMac = /macintosh|mac os x|macintel/i.test(ua) || /mac/i.test(uaDataPlatform);
  const isLinux = /linux|x11/i.test(platformHint) || /linux/i.test(ua);

  let platform = "Unknown";
  if (isIPad) platform = "iPadOS";
  else if (isIPhone) platform = "iOS";
  else if (isAndroid) platform = "Android";
  else if (isChromeOS) platform = "ChromeOS";
  else if (isWindows) platform = "Windows";
  else if (isMac) platform = "macOS";
  else if (isLinux) platform = "Linux";

  let category = "Desktop";
  if (platform === "iPadOS") category = "Tablet";
  else if (platform === "iOS") category = "Mobile";
  else if (platform === "Android") category = /mobile/i.test(ua) ? "Mobile" : "Tablet";
  else if (platform === "ChromeOS") category = "Laptop";
  else if (/tablet|silk/i.test(ua)) category = "Tablet";
  else if (MOBILE_HINT.test(ua)) category = "Mobile";

  let model = null;
  if (platform === "Android") model = androidModelFromUserAgent(ua);

  let avatar = "generic";
  if (platform === "Windows") avatar = "windows";
  else if (platform === "macOS") avatar = "mac";
  else if (platform === "Linux") avatar = "linux";
  else if (platform === "ChromeOS") avatar = "laptop";
  else if (platform === "iOS") avatar = "iphone";
  else if (platform === "iPadOS") avatar = "tablet";
  else if (platform === "Android") avatar = category === "Tablet" ? "tablet" : "android";
  else if (category === "Tablet") avatar = "tablet";
  else if (category === "Mobile") avatar = "mobile";

  const label = model ? formatModelLabel(model) : PLATFORM_LABELS[platform] ?? "Device";

  return {
    platform,
    category,
    deviceType: category,
    browser: detectBrowser(ua),
    model: model ? formatModelLabel(model) : null,
    modelLabel: label,
    avatar,
    touchPoints,
  };
}

/** `Mac · macOS · Chrome` style subtitle, without repeating a value. */
export function formatDeviceSubtitle(profile = {}) {
  const parts = [];
  for (const value of [profile.deviceType, profile.platform, profile.browser]) {
    const label = cleanDeviceLabel(value);
    if (label && !parts.includes(label)) parts.push(label);
  }
  return parts.join(" · ");
}

/* --------------------------------------------------------------------------
   Public metadata
   -------------------------------------------------------------------------- */

/**
 * The only device metadata Droply ever sends. It contains no hardware id,
 * serial, MAC address, screen size or fingerprint.
 */
export function identityMetadata(identity) {
  if (!identity) return null;
  return {
    deviceId: identity.deviceId,
    name: cleanDeviceName(identity.name, "Droply device"),
    deviceType: cleanDeviceLabel(identity.deviceType, "Desktop"),
    platform: cleanDeviceLabel(identity.platform, "Unknown"),
    browser: cleanDeviceLabel(identity.browser, "Browser"),
    avatar: sanitizeAvatarId(identity.avatar),
    model: identity.model ? cleanDeviceLabel(identity.model) : null,
  };
}

/**
 * Validates metadata received from another device (or from storage). Returns
 * a fresh object with only known fields, or null when the identity is
 * unusable. The device id must be the same shape as a signing-key hash.
 */
export function parseDeviceMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deviceId = String(value.deviceId ?? "");
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
  const name = cleanDeviceName(value.name);
  if (!name) return null;
  return {
    deviceId,
    name,
    deviceType: cleanDeviceLabel(value.deviceType, "Desktop"),
    platform: cleanDeviceLabel(value.platform, "Unknown"),
    browser: cleanDeviceLabel(value.browser, "Browser"),
    avatar: sanitizeAvatarId(value.avatar),
    model: value.model ? cleanDeviceLabel(value.model) : null,
  };
}
