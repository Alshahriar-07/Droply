/**
 * Device profile: conservative detection, a secure 4-digit discriminator,
 * avatar mapping, metadata validation and persistence through the identity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  AVATAR_IDS,
  buildDeviceName,
  detectDeviceEnvironment,
  formatDeviceSubtitle,
  parseDeviceMetadata,
  randomDeviceSuffix,
  sanitizeAvatarId,
} = await import(pathToFileURL(path.join(ROOT, "js/core/device-profile.js")).href);
const { loadDeviceIdentity } = await import(
  pathToFileURL(path.join(ROOT, "js/core/device-identity.js")).href
);
const { createMemoryStore } = await import(
  pathToFileURL(path.join(ROOT, "js/core/storage/store.js")).href
);

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; OPPO A5x Build/TP1A.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36";
const CHROME_ANDROID_GENERIC =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

test("Windows is detected as a desktop without inventing a model", () => {
  const env = detectDeviceEnvironment({ userAgent: CHROME_WINDOWS, platform: "Win32" });
  assert.equal(env.platform, "Windows");
  assert.equal(env.category, "Desktop");
  assert.equal(env.deviceType, "Desktop");
  assert.equal(env.browser, "Chrome");
  assert.equal(env.model, null);
  assert.equal(env.avatar, "windows");
  assert.equal(buildDeviceName(env.modelLabel, "3141"), "Windows-3141");
});

test("an Android model is used only when the UA really carries one", () => {
  const oppo = detectDeviceEnvironment({ userAgent: CHROME_ANDROID, platform: "Linux armv8l" });
  assert.equal(oppo.platform, "Android");
  assert.equal(oppo.category, "Mobile");
  assert.equal(oppo.model, "OppoA5x");
  assert.equal(oppo.avatar, "android");
  assert.equal(buildDeviceName(oppo.modelLabel, "2345"), "OppoA5x-2345");

  const unknown = detectDeviceEnvironment({
    userAgent: CHROME_ANDROID_GENERIC,
    platform: "Linux armv8l",
  });
  assert.equal(unknown.model, null, "a generic 'K' is not a model");
  assert.equal(unknown.modelLabel, "Android");
  assert.match(buildDeviceName(unknown.modelLabel, "7234"), /^Android-7234$/);
});

test("iPhone and iPad fall back to platform names, never a guessed model", () => {
  const iphone = detectDeviceEnvironment({ userAgent: SAFARI_IPHONE, platform: "iPhone" });
  assert.equal(iphone.platform, "iOS");
  assert.equal(iphone.category, "Mobile");
  assert.equal(iphone.model, null);
  assert.equal(iphone.avatar, "iphone");
  assert.equal(buildDeviceName(iphone.modelLabel, "3452"), "iPhone-3452");

  const ipad = detectDeviceEnvironment({
    userAgent: SAFARI_IPAD,
    platform: "MacIntel",
    maxTouchPoints: 5,
  });
  assert.equal(ipad.platform, "iPadOS");
  assert.equal(ipad.category, "Tablet");
  assert.equal(ipad.avatar, "tablet");
  assert.equal(buildDeviceName(ipad.modelLabel, "3452"), "iPad-3452");
});

test("macOS and browser variants are labelled consistently", () => {
  const mac = detectDeviceEnvironment({ userAgent: CHROME_MAC, platform: "MacIntel" });
  assert.equal(mac.platform, "macOS");
  assert.equal(mac.browser, "Chrome");
  assert.equal(mac.avatar, "mac");
  assert.equal(buildDeviceName(mac.modelLabel, "8291"), "Mac-8291");

  const edge = detectDeviceEnvironment({
    userAgent: `${CHROME_WINDOWS} Edg/126.0.0.0`,
    platform: "Win32",
  });
  assert.equal(edge.browser, "Edge");
  assert.equal(
    formatDeviceSubtitle({ deviceType: "Desktop", platform: "Windows", browser: "Edge" }),
    "Desktop · Windows · Edge",
  );
});

test("the 4-digit suffix is secure, stable in format and never zero-padded", () => {
  const seen = new Set();
  for (let index = 0; index < 300; index += 1) {
    const suffix = randomDeviceSuffix();
    assert.match(suffix, /^[1-9]\d{3}$/);
    assert.ok(Number(suffix) >= 1000 && Number(suffix) <= 9999);
    seen.add(suffix);
  }
  assert.ok(seen.size > 250, "suffixes must not repeat in practice");
});

test("avatars are a closed set and unknown values fall back", () => {
  for (const id of AVATAR_IDS) assert.equal(sanitizeAvatarId(id), id);
  assert.equal(sanitizeAvatarId("../../evil.svg"), "generic");
  assert.equal(sanitizeAvatarId(""), "generic");
  assert.equal(sanitizeAvatarId("ANDROID"), "android");
});

test("public metadata is reduced to known fields and validated", () => {
  const metadata = parseDeviceMetadata({
    deviceId: "abcdefghijklmnop",
    name: "\u0000Windows   box ",
    deviceType: "Desktop",
    platform: "Windows",
    browser: "Chrome",
    avatar: "windows",
    serial: "should-not-survive",
  });
  assert.deepEqual(metadata, {
    deviceId: "abcdefghijklmnop",
    name: "Windows box",
    deviceType: "Desktop",
    platform: "Windows",
    browser: "Chrome",
    avatar: "windows",
    model: null,
  });
  assert.equal(parseDeviceMetadata({ ...metadata, deviceId: "short" }), null);
  assert.equal(parseDeviceMetadata({ ...metadata, name: "\u0000" }), null);
  assert.equal(parseDeviceMetadata("nope"), null);
});

test("a profile is created once, persisted across loads and keeps its keys", async () => {
  const store = createMemoryStore();
  const first = await loadDeviceIdentity({ store });
  const second = await loadDeviceIdentity({ store });

  assert.match(first.name, /^[A-Za-z]+-\d{4}$/);
  assert.equal(first.suffix, second.suffix);
  assert.equal(first.name, second.name);
  assert.equal(first.avatar, second.avatar);
  assert.equal(first.deviceId, second.deviceId);

  const stored = await store.get("device.identity.v1");
  assert.equal(stored.suffix, first.suffix);
  assert.equal(stored.avatar, first.avatar);
  assert.equal(stored.platform, first.platform);
  assert.equal(stored.browser, first.browser);
});

test("renaming, avatar selection and regeneration persist and stay consistent", async () => {
  const store = createMemoryStore();
  const identity = await loadDeviceIdentity({ store });

  await identity.rename("Kitchen Laptop");
  await identity.setAvatar("laptop");
  assert.equal(identity.name, "Kitchen Laptop");
  assert.equal(identity.avatar, "laptop");
  assert.equal(identity.profile.name, "Kitchen Laptop");
  assert.equal(identity.profile.avatar, "laptop");

  const deviceId = identity.deviceId;
  const oldSuffix = identity.suffix;
  await identity.updateProfile({ regenerateSuffix: true });
  assert.notEqual(identity.suffix, oldSuffix);
  assert.match(identity.name, /^[A-Za-z]+-\d{4}$/);
  assert.equal(identity.deviceId, deviceId, "regeneration must not change the pairing identity");

  const reloaded = await loadDeviceIdentity({ store });
  assert.equal(reloaded.name, identity.name);
  assert.equal(reloaded.suffix, identity.suffix);
  assert.equal(reloaded.avatar, "laptop");
  assert.equal(reloaded.deviceId, deviceId);
  await assert.rejects(() => identity.rename("   "), /Choose a device name/);
});
