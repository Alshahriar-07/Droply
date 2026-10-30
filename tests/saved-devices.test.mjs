/**
 * Saved-device storage: saving, listing, renaming, removing, ordering, bound
 * limits and rejection of damaged or invalid device identities.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { SavedDevices, isValidContact, MAX_SAVED_DEVICES } = await import(
  pathToFileURL(path.join(ROOT, "js/core/saved-devices.js")).href
);
const { createMemoryStore } = await import(
  pathToFileURL(path.join(ROOT, "js/core/storage/store.js")).href
);

const PUBLIC_KEY = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};

/** Device ids are 16–64 characters, exactly like the real identity hash. */
const deviceId = (suffix) => `device-${suffix}`.padEnd(20, "0");

const contact = (suffix, overrides = {}) => ({
  id: `saved-${suffix}`,
  deviceId: deviceId(suffix),
  name: `Device ${suffix}`,
  deviceType: "Mac · Chrome",
  publicKey: PUBLIC_KEY,
  ...overrides,
});

test("a paired device is saved, listed and found by device id", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });
  const saved = await devices.save(contact("alpha"));

  assert.equal(saved.deviceId, deviceId("alpha"));
  assert.equal(saved.name, "Device alpha");
  assert.ok(saved.pairedAt > 0);
  assert.deepEqual(await devices.find(deviceId("alpha")), saved);

  const list = await devices.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].publicKey.x, PUBLIC_KEY.x, "only the public key is kept");
  assert.equal("privateKey" in list[0], false);
});

test("saving the same device twice keeps one entry", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });
  await devices.save(contact("alpha", { name: "First name" }));
  await devices.save(contact("alpha", { name: "Second name" }));

  const list = await devices.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Second name");
});

test("renaming changes only the display name", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });
  const saved = await devices.save(contact("alpha"));
  const renamed = await devices.rename(saved.id, "  Kitchen   laptop  ");

  assert.equal(renamed.name, "Kitchen laptop");
  assert.equal(renamed.deviceId, deviceId("alpha"));
  assert.equal(renamed.publicKey.x, PUBLIC_KEY.x);
});

test("removing a device deletes it permanently", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });
  const saved = await devices.save(contact("alpha"));
  await devices.save(contact("beta"));

  assert.equal(await devices.remove(saved.id), true);
  assert.equal(await devices.find(deviceId("alpha")), null);
  assert.equal((await devices.list()).length, 1);
  assert.equal(await devices.remove("does-not-exist"), false);
});

test("avatar and platform metadata are stored and refreshed after a signed invite", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });
  const saved = await devices.save(
    contact("alpha", { avatar: "android", platform: "Android", browser: "Chrome" }),
  );
  assert.equal(saved.avatar, "android");
  assert.equal(saved.platform, "Android");

  const updated = await devices.updateIdentity(deviceId("alpha"), {
    name: "OppoA5x-2345",
    avatar: "../../evil",
    deviceType: "Mobile",
    platform: "Android",
    browser: "Chrome",
  });
  assert.equal(updated.name, "OppoA5x-2345");
  assert.equal(updated.avatar, "generic", "unknown avatars never reach the UI");
  assert.equal(updated.deviceType, "Mobile");
  assert.equal(updated.lastConnectedAt, saved.lastConnectedAt, "refreshing display data is not a connection");
  assert.equal((await devices.find(deviceId("alpha"))).name, "OppoA5x-2345");
});

test("last connected time is recorded and sorts the list", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });
  await devices.save(contact("alpha"));
  await devices.save(contact("beta"));

  await devices.markSeen(deviceId("alpha"), Date.now() + 60_000);
  const list = await devices.list();
  assert.equal(list[0].deviceId, deviceId("alpha"));
  assert.ok(list[0].lastConnectedAt > list[1].lastConnectedAt);
});

test("saved devices are bounded", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });
  for (let index = 0; index < MAX_SAVED_DEVICES + 5; index += 1) {
    await devices.save(contact(String(index).padStart(3, "0")));
  }
  assert.equal((await devices.list()).length, MAX_SAVED_DEVICES);
});

test("an invalid device identity is refused at save time", async () => {
  const devices = new SavedDevices({ store: createMemoryStore() });

  await assert.rejects(() => devices.save(contact("alpha", { deviceId: "bad id with spaces" })), /not valid/);
  await assert.rejects(
    () => devices.save(contact("alpha", { publicKey: { kty: "oct", k: "secret" } })),
    /usable public key/,
  );
  await assert.rejects(
    () => devices.save({ deviceId: deviceId("alpha"), name: "X" }),
    /usable public key/,
  );
  assert.equal((await devices.list()).length, 0);
});

test("a damaged stored record is dropped instead of surfacing a broken device", async () => {
  const store = createMemoryStore({
    "saved-devices.v1": [
      {
        id: "d1",
        deviceId: deviceId("alpha"),
        name: "Alpha",
        deviceType: "Mac · Chrome",
        publicKey: PUBLIC_KEY,
        pairedAt: Date.now(),
        lastConnectedAt: Date.now(),
      },
      { id: "d2", deviceId: "../../etc/passwd", name: "Bad", publicKey: {} },
      { id: "d3", deviceId: deviceId("gamma"), name: "Gamma", publicKey: { kty: "RSA" } },
      null,
    ],
  });
  const devices = new SavedDevices({ store });
  const list = await devices.list();

  assert.equal(list.length, 1);
  assert.equal(list[0].deviceId, deviceId("alpha"));
  // The repaired list is written back, so the bad rows never return.
  const stored = await store.get("saved-devices.v1");
  assert.equal(stored.length, 1);
});

test("isValidContact checks the identity fields a reconnection depends on", () => {
  assert.equal(isValidContact(contact("alpha")), true);
  assert.equal(
    isValidContact(contact("alpha", { publicKey: { kty: "EC", crv: "P-384", x: "a", y: "b" } })),
    false,
  );
  assert.equal(isValidContact({ ...contact("alpha"), name: "  " }), false);
  assert.equal(isValidContact(null), false);
});
