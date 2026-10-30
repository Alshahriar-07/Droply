/**
 * Saved Devices storage.
 *
 * What is persisted per paired device:
 *   id, deviceId, name, deviceType, publicKey (JWK), pairedAt, lastConnectedAt
 *
 * What is never persisted: private keys (they stay non-extractable in the
 * identity record), file contents, room codes, or any transfer history.
 */

import { isValidDeviceId } from "./device-identity.js";
import { cleanDeviceLabel, sanitizeAvatarId } from "./device-profile.js";

const DEVICES_KEY = "saved-devices.v1";
export const MAX_SAVED_DEVICES = 20;
const NAME_LIMIT = 40;

/** A stored record is only usable if its identity fields are intact. */
export function isValidContact(value) {
  if (!value || typeof value !== "object") return false;
  if (!isValidDeviceId(value.deviceId)) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (typeof value.name !== "string" || !value.name.trim()) return false;
  const key = value.publicKey;
  if (!key || typeof key !== "object" || key.kty !== "EC" || key.crv !== "P-256") return false;
  if (typeof key.x !== "string" || typeof key.y !== "string") return false;
  return true;
}

/** Display-safe name without control characters. */
export function cleanDeviceName(value, fallback = "Saved device") {
  const clean = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_LIMIT);
  return clean || fallback;
}

export class SavedDevices {
  /** @param {{ store: import("./storage/store.js").KeyValueStore }} options */
  constructor({ store }) {
    this.store = store;
    /** @type {Array<object>|null} */
    this.cache = null;
  }

  /** All valid contacts, most recently connected first. */
  async list() {
    const raw = await this.store.get(DEVICES_KEY);
    const records = Array.isArray(raw) ? raw : [];
    const valid = [];
    let repaired = false;
    for (const record of records) {
      if (isValidContact(record)) {
        valid.push({
          id: record.id,
          deviceId: record.deviceId,
          name: cleanDeviceName(record.name),
          deviceType: cleanDeviceLabel(record.deviceType, "Desktop"),
          platform: cleanDeviceLabel(record.platform),
          browser: cleanDeviceLabel(record.browser),
          avatar: sanitizeAvatarId(record.avatar),
          publicKey: record.publicKey,
          pairedAt: Number(record.pairedAt) || Date.now(),
          lastConnectedAt: Number(record.lastConnectedAt) || Number(record.pairedAt) || Date.now(),
        });
      } else {
        repaired = true;
      }
    }
    if (repaired) await this.#write(valid);
    this.cache = valid;
    return valid.map((record) => ({ ...record }));
  }

  /** @param {string} deviceId */
  async find(deviceId) {
    if (!isValidDeviceId(deviceId)) return null;
    const list = this.cache ?? (await this.list());
    return list.find((record) => record.deviceId === deviceId) ?? null;
  }

  /**
   * Adds or updates a contact. Pairing the same device twice keeps one record.
   * @param {{ deviceId: string, name: string, deviceType?: string, publicKey: object }} contact
   */
  async save(contact) {
    const list = this.cache ?? (await this.list());
    const deviceId = String(contact?.deviceId ?? "");
    if (!isValidDeviceId(deviceId)) throw new Error("That device identity is not valid.");
    const publicKey = contact?.publicKey;
    if (!publicKey || publicKey.kty !== "EC" || publicKey.crv !== "P-256") {
      throw new Error("That device did not send a usable public key.");
    }

    const existing = list.find((record) => record.deviceId === deviceId);
    const now = Date.now();
    const record = {
      id: existing?.id ?? `d${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      deviceId,
      name: cleanDeviceName(contact.name, "Saved device"),
      deviceType: cleanDeviceLabel(contact.deviceType, "Desktop"),
      platform: cleanDeviceLabel(contact.platform),
      browser: cleanDeviceLabel(contact.browser),
      avatar: sanitizeAvatarId(contact.avatar),
      publicKey,
      pairedAt: existing?.pairedAt ?? now,
      lastConnectedAt: now,
    };

    const next = [record, ...list.filter((item) => item.deviceId !== deviceId)].slice(
      0,
      MAX_SAVED_DEVICES,
    );
    await this.#write(next);
    return { ...record };
  }

  /** @param {string} id @param {string} name */
  async rename(id, name) {
    const list = this.cache ?? (await this.list());
    const record = list.find((item) => item.id === id);
    if (!record) throw new Error("That saved device no longer exists.");
    const next = list.map((item) =>
      item.id === id ? { ...item, name: cleanDeviceName(name, item.name) } : item,
    );
    await this.#write(next);
    return next.find((item) => item.id === id);
  }

  /** @param {string} id */
  async remove(id) {
    const list = this.cache ?? (await this.list());
    const next = list.filter((item) => item.id !== id);
    await this.#write(next);
    return list.length !== next.length;
  }

  /**
   * Refreshes the public display fields of a saved device. Called only after a
   * signed invite proves the update came from that device's key.
   * @param {string} deviceId
   * @param {{ name?: string, deviceType?: string, platform?: string, browser?: string, avatar?: string }} metadata
   */
  async updateIdentity(deviceId, metadata = {}) {
    const list = this.cache ?? (await this.list());
    const record = list.find((item) => item.deviceId === deviceId);
    if (!record) return null;
    const next = list.map((item) =>
      item.deviceId === deviceId
        ? {
            ...item,
            name: cleanDeviceName(metadata.name, item.name),
            deviceType: cleanDeviceLabel(metadata.deviceType, item.deviceType),
            platform: cleanDeviceLabel(metadata.platform, item.platform),
            browser: cleanDeviceLabel(metadata.browser, item.browser),
            avatar: sanitizeAvatarId(metadata.avatar ?? item.avatar),
          }
        : item,
    );
    await this.#write(next);
    return next.find((item) => item.deviceId === deviceId);
  }

  /** Records a successful connection for the "last connected" label. */
  async markSeen(deviceId, at = Date.now()) {
    const list = this.cache ?? (await this.list());
    const record = list.find((item) => item.deviceId === deviceId);
    if (!record) return null;
    const next = list.map((item) => (item.deviceId === deviceId ? { ...item, lastConnectedAt: at } : item));
    await this.#write(next);
    return next.find((item) => item.deviceId === deviceId);
  }

  async #write(list) {
    const sorted = [...list].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
    this.cache = sorted;
    await this.store.set(DEVICES_KEY, sorted);
  }
}
