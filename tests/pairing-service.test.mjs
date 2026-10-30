/**
 * Pairing sessions: the Pairing Durable Object and the Worker routes in front
 * of it.
 *
 * Covered here: code format and generation, server-side uniqueness, status
 * authentication, one-time redemption, expiry, rotation, teardown and the
 * brute-force rate limit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  Pairing,
  PAIRING_ALPHABET,
  PAIRING_CODE_PATTERN,
  PAIRING_TTL_MS,
  randomPairingCode,
  sanitizePeer,
} = await import(pathToFileURL(path.join(ROOT, "worker/src/pairing.js")).href);
const { hashToken } = await import(
  pathToFileURL(path.join(ROOT, "worker/src/util.js")).href
);
const worker = (await import(pathToFileURL(path.join(ROOT, "worker/src/index.js")).href))
  .default;

/* --------------------------------------------------------------------------
   Fakes
   -------------------------------------------------------------------------- */

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async deleteAll() {
    this.map.clear();
  }
  async setAlarm(at) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

class FakeState {
  constructor() {
    this.storage = new FakeStorage();
  }
}

/* --------------------------------------------------------------------------
   Fixtures
   -------------------------------------------------------------------------- */

const owner = {
  deviceId: "device-alpha-1234",
  name: "Alpha",
  deviceType: "Mac · Chrome",
  publicKey: { kty: "EC", crv: "P-256", x: "a".repeat(43), y: "b".repeat(43) },
  agreementKey: { kty: "EC", crv: "P-256", x: "c".repeat(43), y: "d".repeat(43) },
};

const peer = {
  deviceId: "device-beta-5678",
  name: "Beta",
  deviceType: "Android · Chrome",
  publicKey: { kty: "EC", crv: "P-256", x: "e".repeat(43), y: "f".repeat(43) },
  agreementKey: { kty: "EC", crv: "P-256", x: "g".repeat(43), y: "h".repeat(43) },
};

const CODE = "A7K9P2";
const TOKEN = "owner-token-value";

async function post(pairing, action, body) {
  const response = await pairing.fetch(
    new Request(`https://pair/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

async function init(pairing, overrides = {}) {
  return post(pairing, "init", {
    code: CODE,
    owner,
    tokenHash: await hashToken(TOKEN),
    ttlSeconds: 300,
    ...overrides,
  });
}

/** A Durable Object namespace whose stub answers from `handler`. */
function namespace(handler) {
  return {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(init.body) : {};
        const reply = await handler(url.pathname, body, name);
        return new Response(JSON.stringify(reply.data ?? {}), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
}

const unrestricted = { idFromName: (x) => x, get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }) };

function workerEnv(pairing, extra = {}) {
  return {
    ALLOWED_ORIGINS: "*",
    ROOM: unrestricted,
    RATE_LIMITER: unrestricted,
    PAIRING: pairing,
    ...extra,
  };
}

function workerRequest(pathname, body) {
  return new Request(`https://droply-signaling.example${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://droply-files.vercel.app" },
    body: JSON.stringify(body),
  });
}

/* --------------------------------------------------------------------------
   Code generation
   -------------------------------------------------------------------------- */

test("generated codes are six unambiguous characters and not predictable", () => {
  const seen = new Set();
  for (let index = 0; index < 500; index += 1) {
    const code = randomPairingCode();
    assert.match(code, PAIRING_CODE_PATTERN);
    assert.equal(code.length, 6);
    for (const char of code) assert.ok(PAIRING_ALPHABET.includes(char));
    seen.add(code);
  }
  assert.ok(seen.size > 480, "codes must not repeat in practice");
  for (const ambiguous of ["O", "0", "I", "1"]) {
    assert.equal(PAIRING_ALPHABET.includes(ambiguous), false);
  }
});

test("a peer payload is sanitised and incomplete keys are refused", () => {
  assert.equal(sanitizePeer({ ...owner, deviceId: "short" }), null);
  assert.equal(sanitizePeer({ ...owner, publicKey: null }), null);
  assert.equal(sanitizePeer({ ...owner, agreementKey: { kty: "RSA" } }), null);
  assert.equal(sanitizePeer("nope"), null);

  const cleaned = sanitizePeer({
    ...owner,
    name: "\u0000Alpha\u0007  Laptop\n",
    platform: "Windows",
    browser: "Chrome",
    avatar: "../../evil",
    extra: "x",
  });
  assert.equal(cleaned.name, "Alpha Laptop");
  assert.equal(cleaned.platform, "Windows");
  assert.equal(cleaned.browser, "Chrome");
  assert.equal(cleaned.avatar, "generic", "avatar ids are a closed set");
  assert.equal("extra" in cleaned, false);
  assert.deepEqual(cleaned.publicKey, owner.publicKey);
});

/* --------------------------------------------------------------------------
   Durable Object behaviour
   -------------------------------------------------------------------------- */

test("init stores a five-minute session and only the owner token can read it", async () => {
  const pairing = new Pairing(new FakeState());
  const created = await init(pairing);

  assert.equal(created.status, 200);
  assert.equal(created.data.code, CODE);
  assert.ok(Math.abs(created.data.expiresAt - (Date.now() + PAIRING_TTL_MS)) < 2000);
  assert.equal(pairing.session.ownerTokenHash, await hashToken(TOKEN));
  assert.equal("token" in pairing.session, false, "the raw token is never stored");

  const unauthorised = await post(pairing, "status", { token: "wrong" });
  assert.equal(unauthorised.status, 401);

  const waiting = await post(pairing, "status", { token: TOKEN });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.data.state, "waiting");
  assert.equal(waiting.data.peer, null);
});

test("a code can be redeemed exactly once and then reports the paired keys", async () => {
  const pairing = new Pairing(new FakeState());
  await init(pairing);

  const joined = await post(pairing, "join", { peer });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.owner.deviceId, owner.deviceId);
  assert.equal(joined.data.owner.publicKey.x, owner.publicKey.x);
  assert.equal("ownerTokenHash" in joined.data.owner, false);

  const second = await post(pairing, "join", { peer: { ...peer, deviceId: "device-gamma-9012" } });
  assert.equal(second.status, 409);
  assert.equal(second.data.error, "pair_used");

  const status = await post(pairing, "status", { token: TOKEN });
  assert.equal(status.data.state, "joined");
  assert.equal(status.data.peer.deviceId, peer.deviceId);
  assert.equal(status.data.peer.publicKey.y, peer.publicKey.y);
});

test("self-pairing and a second live session for one code are refused", async () => {
  const pairing = new Pairing(new FakeState());
  await init(pairing);

  const self = await post(pairing, "join", { peer: owner });
  assert.equal(self.status, 409);
  assert.equal(self.data.error, "pair_self");

  const duplicate = await init(pairing);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, "pair_exists");
});

test("an expired code is cleaned up and reports pair_expired", async () => {
  const state = new FakeState();
  const pairing = new Pairing(state);
  await init(pairing);

  pairing.session.expiresAt = Date.now() - 1;
  await state.storage.put("session", pairing.session);

  // A join on an expired code is explicit about why it failed…
  const join = await post(pairing, "join", { peer });
  assert.equal(join.status, 410);
  assert.equal(join.data.error, "pair_expired");
  assert.ok(!state.storage.map.has("session"), "expired sessions leave nothing behind");

  // …and afterwards the code simply doesn't exist.
  const status = await post(pairing, "status", { token: TOKEN });
  assert.equal(status.status, 404);
  assert.equal(status.data.error, "pair_not_found");

  await init(pairing, { code: "D9F2K7" });
  pairing.session.expiresAt = Date.now() - 1;
  await state.storage.put("session", pairing.session);
  await pairing.alarm();
  assert.ok(!state.storage.map.has("session"));
  assert.equal(state.storage.alarm, null);
});

test("consume needs the owner token and ends the session immediately", async () => {
  const pairing = new Pairing(new FakeState());
  await init(pairing);

  const refused = await post(pairing, "consume", { token: "wrong" });
  assert.equal(refused.status, 401);

  const closed = await post(pairing, "consume", { token: TOKEN });
  assert.equal(closed.status, 200);

  const after = await post(pairing, "status", { token: TOKEN });
  assert.equal(after.status, 404);
  assert.equal(after.data.error, "pair_not_found");
});

test("verify reports whether a session was already redeemed", async () => {
  const pairing = new Pairing(new FakeState());
  await init(pairing);

  const before = await post(pairing, "verify", { token: TOKEN });
  assert.equal(before.status, 200);
  assert.equal(before.data.joined, false);

  await post(pairing, "join", { peer });
  const after = await post(pairing, "verify", { token: TOKEN });
  assert.equal(after.data.joined, true);
  assert.equal((await post(pairing, "verify", { token: "wrong" })).status, 401);
});

/* --------------------------------------------------------------------------
   Worker routes
   -------------------------------------------------------------------------- */

test("POST /api/pair returns a short code, a fresh token and retries collisions", async () => {
  let inits = 0;
  let attempts = 0;
  const pairing = namespace(async (pathname, body) => {
    if (pathname === "/init") {
      inits += 1;
      attempts += 1;
      // First live collision, then success.
      if (inits === 1) return { status: 409, data: { error: "pair_exists" } };
      return {
        status: 200,
        data: { code: body.code, expiresAt: Date.now() + PAIRING_TTL_MS, ttlSeconds: 300 },
      };
    }
    return { status: 404, data: { error: "not_found" } };
  });

  const response = await worker.fetch(workerRequest("/api/pair", owner), workerEnv(pairing));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.match(data.code, PAIRING_CODE_PATTERN);
  assert.equal(typeof data.token, "string");
  assert.ok(data.token.length > 20);
  assert.equal(attempts, 2, "a collision must be retried with a new code");
  assert.ok(data.expiresAt > Date.now());
});

test("POST /api/pair rejects incomplete device details", async () => {
  const pairing = namespace(async () => ({ status: 200, data: {} }));
  const response = await worker.fetch(
    workerRequest("/api/pair", { ...owner, publicKey: null }),
    workerEnv(pairing),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "bad_request");
});

test("the join route maps expiry, reuse and unknown codes to clear errors", async () => {
  const expired = namespace(async () => ({ status: 410, data: { error: "pair_expired" } }));
  const expiredResponse = await worker.fetch(
    workerRequest("/api/pair/A7K9P2/join", { peer }),
    workerEnv(expired),
  );
  assert.equal(expiredResponse.status, 410);
  assert.equal((await expiredResponse.json()).error, "pair_expired");

  const used = namespace(async () => ({ status: 409, data: { error: "pair_used" } }));
  const usedResponse = await worker.fetch(
    workerRequest("/api/pair/A7K9P2/join", { peer }),
    workerEnv(used),
  );
  assert.equal(usedResponse.status, 409);
  assert.equal((await usedResponse.json()).error, "pair_used");

  const missing = namespace(async () => ({ status: 404, data: { error: "pair_not_found" } }));
  const missingResponse = await worker.fetch(
    workerRequest("/api/pair/A7K9P2/join", { peer }),
    workerEnv(missing),
  );
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error, "pair_not_found");
});

test("pairing is rate limited per client before any code is issued", async () => {
  const limiter = {
    idFromName: (x) => x,
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ retryAfter: 30 }), { status: 429 }),
    }),
  };
  let inits = 0;
  const pairing = namespace(async (pathname, body) => {
    if (pathname === "/init") {
      inits += 1;
      return {
        status: 200,
        data: { code: body.code, expiresAt: Date.now() + PAIRING_TTL_MS, ttlSeconds: 300 },
      };
    }
    return { status: 404, data: {} };
  });

  const response = await worker.fetch(
    workerRequest("/api/pair", owner),
    workerEnv(pairing, { RATE_LIMITER: limiter }),
  );
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.equal(inits, 0, "no session is created when the client is throttled");
});

test("regenerate rotates a waiting code and refuses a redeemed one", async () => {
  const calls = [];
  const pairing = namespace(async (pathname, body) => {
    calls.push(pathname);
    if (pathname === "/verify") {
      return { status: 200, data: { owner, joined: false, expiresAt: Date.now() + 1000 } };
    }
    if (pathname === "/init") {
      return {
        status: 200,
        data: { code: body.code, expiresAt: Date.now() + PAIRING_TTL_MS, ttlSeconds: 300 },
      };
    }
    if (pathname === "/consume") return { status: 200, data: { ok: true } };
    return { status: 404, data: {} };
  });

  const rotated = await worker.fetch(
    workerRequest("/api/pair/A7K9P2/regenerate", { token: TOKEN }),
    workerEnv(pairing),
  );
  const data = await rotated.json();
  assert.equal(rotated.status, 200);
  assert.match(data.code, PAIRING_CODE_PATTERN);
  assert.notEqual(data.token, TOKEN, "the owner token rotates with the code");
  assert.ok(calls.includes("/consume"), "the old code is retired");

  const joinedPairing = namespace(async (pathname) => {
    if (pathname === "/verify") {
      return { status: 200, data: { owner, joined: true, expiresAt: Date.now() + 1000 } };
    }
    return { status: 500, data: {} };
  });
  const refused = await worker.fetch(
    workerRequest("/api/pair/A7K9P2/regenerate", { token: TOKEN }),
    workerEnv(joinedPairing),
  );
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "pair_joined");
});

test("an unknown pairing route is a 404, not an error page", async () => {
  const pairing = namespace(async () => ({ status: 200, data: {} }));
  const response = await worker.fetch(
    workerRequest("/api/pair/abc/join", { peer }),
    workerEnv(pairing),
  );
  assert.equal(response.status, 404);
});
