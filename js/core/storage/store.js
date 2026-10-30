/**
 * Pluggable key/value storage.
 *
 * Saved devices and the device identity live in IndexedDB, but everything that
 * reads them goes through this tiny adapter so the logic can be tested in Node
 * with an in-memory store and so a browser without IndexedDB degrades to a
 * clear error instead of a crash.
 */

/** @typedef {{ get(key: string): Promise<any>, set(key: string, value: any): Promise<void>, delete(key: string): Promise<void>, keys(): Promise<string[]> }} KeyValueStore */

export class StorageUnavailableError extends Error {
  constructor(message = "This browser did not allow Droply to store saved devices.") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/** @returns {KeyValueStore} */
export function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    async get(key) {
      return data.has(key) ? structuredCloneSafe(data.get(key)) : undefined;
    },
    async set(key, value) {
      data.set(key, structuredCloneSafe(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async keys() {
      return [...data.keys()];
    },
  };
}

/**
 * Structured-clone-like copy for the memory store. CryptoKey values are kept
 * by reference because they cannot be cloned synchronously here, which is
 * exactly how IndexedDB treats them in a browser.
 */
function structuredCloneSafe(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * IndexedDB-backed store. One database, one object store, string keys.
 * @param {{ dbName?: string, storeName?: string, version?: number }} [options]
 * @returns {KeyValueStore}
 */
export function createIndexedDbStore({
  dbName = "droply",
  storeName = "kv",
  version = 1,
} = {}) {
  /** @type {Promise<IDBDatabase>|null} */
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new StorageUnavailableError());
        return;
      }
      let request;
      try {
        request = indexedDB.open(dbName, version);
      } catch {
        reject(new StorageUnavailableError());
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new StorageUnavailableError());
      request.onblocked = () => reject(new StorageUnavailableError("Close other Droply tabs and try again."));
    });
    return opening;
  }

  async function run(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch {
        reject(new StorageUnavailableError());
        return;
      }
      const store = transaction.objectStore(storeName);
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new StorageUnavailableError());
      transaction.onabort = () => reject(transaction.error ?? new StorageUnavailableError());
    });
  }

  return {
    get: (key) => run("readonly", (store) => store.get(key)),
    set: (key, value) => run("readwrite", (store) => store.put(value, key)),
    delete: (key) => run("readwrite", (store) => store.delete(key)),
    keys: () => run("readonly", (store) => store.getAllKeys()).then((keys) => keys.map(String)),
  };
}
