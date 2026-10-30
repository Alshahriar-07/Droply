/**
 * Nearby presence: registration, validation, expiry, duplicate devices,
 * invites and the Worker routes that front the Presence Durable Object.
 *
 * The Presence class is driven with fake hibernatable WebSockets: exactly the
 * handlers Cloudflare calls, without needing the 101 handshake Node can't
 * construct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Presence, PEER_TTL_MS, MAX_PEERS, sanitizeDisplayName } = await import(
  pathToFileURL(path.join(ROOT, "worker/src/presence.js")).href
);
const worker = (await import(pathToFileURL(path.join(ROOT, "worker/src/index.js")).href)).default;

/* --------------------------------------------------------------------------
   Fakes
   -------------------------------------------------------------------------- */

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
    this.writes = 0;
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.writes += 1;
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

class FakeSocket {
  constructor() {
    this.attachment = {};
    this.sent = [];
    this.closed = null;
    this.tags = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  serializeAttachment(value) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

class FakeState {
  constructor() {
    this.storage = new FakeStorage();
    this.sockets = [];
  }
  acceptWebSocket(ws, tags = []) {
    ws.tags = [...tags];
    this.sockets.push(ws);
  }
  getWebSockets(tag) {
    return tag ? this.sockets.filter((socket) => socket.tags.includes(tag)) : [...this.sockets];
  }
}

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

async function register(presence, device) {
  const response = await presence.fetch(
    new Request("https://presence/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(device),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/** Registers a device and attaches a live socket the way #socket would. */
async function connect(presence, state, device) {
  const { body } = await register(presence, device);
  presence.peers[body.peerId].connected = true;
  const socket = new FakeSocket();
  socket.serializeAttachment({ peerId: body.peerId });
  state.acceptWebSocket(socket, [body.peerId]);
  return { peerId: body.peerId, token: body.token, socket, name: device.name };
}

function makeInvite(overrides = {}) {
  return {
    v: 1,
    code: "ABC234",
    fromDeviceId: "device-alpha-1234",
    fromName: "Alpha",
    issuedAt: Date.now(),
    sig: "c2lnbmF0dXJl",
    ...overrides,
  };
}

async function message(presence, socket, payload) {
  await presence.webSocketMessage(socket, JSON.stringify(payload));
}

/* --------------------------------------------------------------------------
   Registration
   -------------------------------------------------------------------------- */

test("register issues a short-lived peer id and token, and sanitises the name", async () => {
  const presence = new Presence(new FakeState());
  const { status, body } = await register(presence, {
    deviceId: "device-alpha-1234",
    name: "\u0000Evil\u0007  Phone\n",
    deviceType: "Android · Chrome",
  });

  assert.equal(status, 200);
  assert.match(body.peerId, /^[a-f0-9]{32}$/);
  assert.ok(body.token.length >= 20);
  assert.equal(body.ttlSeconds, 120);
  assert.equal(presence.peers[body.peerId].name, "Evil Phone");
  assert.equal("tokenHash" in presence.peers[body.peerId], true, "only the hash is stored");
  assert.equal(presence.peers[body.peerId].tokenHash.includes(body.token), false);
});

test("registration rejects malformed device ids and payloads", async () => {
  const presence = new Presence(new FakeState());
  for (const deviceId of ["short", "", "has spaces", "x".repeat(65)]) {
    const { status } = await register(presence, { deviceId, name: "X" });
    assert.equal(status, 400, `${deviceId} must be rejected`);
  }
  const notJson = await presence.fetch(
    new Request("https://presence/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  assert.equal(notJson.status, 400);
});

test("a device is never listed twice: re-registering replaces the old record", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const first = await connect(presence, state, { deviceId: "device-alpha-1234", name: "Alpha" });
  const second = await connect(presence, state, { deviceId: "device-alpha-1234", name: "Alpha" });

  assert.notEqual(first.peerId, second.peerId);
  assert.equal(Object.keys(presence.peers).length, 1);
  assert.deepEqual(first.socket.closed, { code: 4001, reason: "replaced" });
});

test("presence is capped so a network group cannot be flooded", async () => {
  const presence = new Presence(new FakeState());
  for (let index = 0; index < MAX_PEERS; index += 1) {
    const { status } = await register(presence, { deviceId: `device-${index}`.padEnd(10, "x"), name: `D${index}` });
    assert.equal(status, 200);
  }
  const { status, body } = await register(presence, { deviceId: "one-too-many", name: "Extra" });
  assert.equal(status, 429);
  assert.equal(body.error, "presence_full");
});

test("sanitizeDisplayName clamps names to 40 characters", () => {
  assert.equal(sanitizeDisplayName("  a   b  "), "a b");
  assert.equal(sanitizeDisplayName("x".repeat(80)).length, 40);
});

/* --------------------------------------------------------------------------
   Presence list
   -------------------------------------------------------------------------- */

test("presence only lists connected peers and keeps this peer's socket informed", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });
  const beta = await connect(presence, state, { deviceId: "device-beta", name: "Beta" });

  await message(presence, beta.socket, { type: "refresh" });
  const snapshot = beta.socket.sent.at(-1);

  assert.equal(snapshot.type, "presence");
  const names = snapshot.peers.map((peer) => peer.name).sort();
  assert.deepEqual(names, ["Alpha", "Beta"]);
  assert.equal(snapshot.peers.some((peer) => "tokenHash" in peer), false);

  // An expired record is not advertised, even before the alarm runs.
  presence.peers[alpha.peerId].lastSeen = Date.now() - PEER_TTL_MS - 1;
  await message(presence, beta.socket, { type: "refresh" });
  assert.deepEqual(
    beta.socket.sent.at(-1).peers.map((peer) => peer.name),
    ["Beta"],
  );
});

test("availability changes are broadcast to the group", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });
  const beta = await connect(presence, state, { deviceId: "device-beta", name: "Beta" });

  await message(presence, alpha.socket, { type: "availability", available: false });
  const seen = beta.socket.sent.at(-1);
  const alphaEntry = seen.peers.find((peer) => peer.name === "Alpha");
  assert.equal(alphaEntry.available, false);
});

test("closing a socket removes the presence record immediately", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });

  assert.equal(Object.keys(presence.peers).length, 1);
  await presence.webSocketClose(alpha.socket);
  assert.equal(Object.keys(presence.peers).length, 0);
  assert.equal((await presence.fetch(new Request("https://presence/count"))).status, 200);
});

test("leaving removes the record and closes the socket", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });

  await message(presence, alpha.socket, { type: "leave" });
  assert.equal(Object.keys(presence.peers).length, 0);
  assert.equal(alpha.socket.closed.code, 1000);
});

/* --------------------------------------------------------------------------
   Expiry
   -------------------------------------------------------------------------- */

test("the alarm expires inactive presence and closes the socket", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });
  presence.peers[alpha.peerId].lastSeen = Date.now() - PEER_TTL_MS - 5;

  await presence.alarm();

  assert.equal(Object.keys(presence.peers).length, 0);
  assert.deepEqual(alpha.socket.closed, { code: 4008, reason: "expired" });
  assert.equal(state.storage.alarm, null, "no record left means no alarm left");
});

test("an active record keeps its alarm, so presence is not silently extended", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });
  const expected = presence.peers[alpha.peerId].lastSeen + PEER_TTL_MS;

  await presence.alarm();
  assert.equal(Object.keys(presence.peers).length, 1);
  assert.equal(state.storage.alarm, expected);
});

/* --------------------------------------------------------------------------
   Authorization and message validation
   -------------------------------------------------------------------------- */

test("a socket for an unknown presence record is closed, not served", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });

  const rogue = new FakeSocket();
  rogue.serializeAttachment({ peerId: "f".repeat(32) });
  state.acceptWebSocket(rogue, ["f".repeat(32)]);

  await message(presence, rogue, { type: "refresh" });
  assert.deepEqual(rogue.closed, { code: 4004, reason: "unknown-peer" });
  assert.equal(rogue.sent.length, 0, "no presence data leaked to an unauthenticated socket");
});

test("binary frames and oversized messages are refused", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });

  await presence.webSocketMessage(alpha.socket, new Uint8Array([1, 2, 3]));
  assert.equal(alpha.socket.closed.code, 1003);

  const beta = await connect(presence, state, { deviceId: "device-beta", name: "Beta" });
  await presence.webSocketMessage(beta.socket, "x".repeat(9000));
  assert.equal(beta.socket.closed.code, 1009);
});

test("malformed JSON and unknown message types produce an error, not a crash", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });

  await presence.webSocketMessage(alpha.socket, "{");
  assert.equal(alpha.socket.sent.at(-1).code, "invalid_message");

  await message(presence, alpha.socket, { type: "teleport" });
  assert.equal(alpha.socket.sent.at(-1).code, "unknown_type");
});

/* --------------------------------------------------------------------------
   Invites
   -------------------------------------------------------------------------- */

test("an invite is relayed to exactly one peer and acknowledged", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });
  const beta = await connect(presence, state, { deviceId: "device-beta", name: "Beta" });

  await message(presence, alpha.socket, {
    type: "invite",
    to: beta.peerId,
    invite: makeInvite({ to: beta.peerId }),
  });

  const delivered = beta.socket.sent.find((entry) => entry.type === "invite");
  assert.ok(delivered, "the target receives the invite");
  assert.equal(delivered.from.name, "Alpha");
  assert.equal(delivered.from.deviceId, "device-alpha");
  assert.equal(delivered.invite.code, "ABC234");
  assert.equal("tokenHash" in delivered.from, false);

  assert.deepEqual(alpha.socket.sent.at(-1), {
    type: "invite-sent",
    to: beta.peerId,
    delivered: true,
  });
});

test("an invite to a departed device reports failure instead of pretending", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });

  await message(presence, alpha.socket, {
    type: "invite",
    to: "f".repeat(32),
    invite: makeInvite({ to: "f".repeat(32) }),
  });
  assert.equal(alpha.socket.sent.at(-1).type, "invite-sent");
  assert.equal(alpha.socket.sent.at(-1).delivered, false);
});

test("invite payloads are validated before they are relayed", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });
  const beta = await connect(presence, state, { deviceId: "device-beta", name: "Beta" });

  const bad = [
    makeInvite({ code: "NOPE" }),
    makeInvite({ fromDeviceId: "" }),
    makeInvite({ sig: "" }),
    makeInvite({ issuedAt: "soon" }),
    makeInvite({ fromName: "x".repeat(61) }),
  ];
  for (const invite of bad) {
    await message(presence, alpha.socket, { type: "invite", to: beta.peerId, invite });
    assert.equal(alpha.socket.sent.at(-1).code, "invalid_invite");
  }
  assert.equal(beta.socket.sent.some((entry) => entry.type === "invite"), false);
});

test("an invite response is relayed back with the decision", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const alpha = await connect(presence, state, { deviceId: "device-alpha", name: "Alpha" });
  const beta = await connect(presence, state, { deviceId: "device-beta", name: "Beta" });

  await message(presence, beta.socket, {
    type: "invite-response",
    to: alpha.peerId,
    accepted: false,
  });

  const response = alpha.socket.sent.find((entry) => entry.type === "invite-response");
  assert.equal(response.accepted, false);
  assert.equal(response.from.name, "Beta");
});

/* --------------------------------------------------------------------------
   Worker routes
   -------------------------------------------------------------------------- */

const PROD = "https://droply-files.vercel.app";

function workerEnv(capture) {
  return {
    ALLOWED_ORIGINS: PROD,
    PRESENCE: {
      idFromName(name) {
        capture.group = name;
        return name;
      },
      get() {
        return {
          async fetch(url, init) {
            capture.url = String(url);
            capture.body = init?.body ? JSON.parse(init.body) : null;
            return new Response(
              JSON.stringify({
                peerId: "a".repeat(32),
                token: "t".repeat(32),
                expiresAt: Date.now() + 120_000,
                ttlSeconds: 120,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        };
      },
    },
  };
}

test("the Worker forwards nearby registration with a hashed network group", async () => {
  const capture = {};
  const response = await worker.fetch(
    new Request("https://worker.dev/api/nearby/register", {
      method: "POST",
      headers: {
        origin: PROD,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify({
        deviceId: "device-alpha-1234",
        name: "  My Phone\u0000 ",
        deviceType: "Mobile",
        platform: "Android",
        browser: "Chrome",
        avatar: "android",
      }),
    }),
    workerEnv(capture),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), PROD);
  const data = await response.json();
  assert.equal(data.peerId, "a".repeat(32));

  // A 32 character hash, never the address itself.
  assert.match(capture.group, /^[a-f0-9]{32}$/);
  assert.equal(capture.group.includes("203.0.113.9"), false);
  assert.equal(capture.body.name, "My Phone");
  assert.equal(capture.body.deviceType, "Mobile");
  assert.equal(capture.body.platform, "Android");
  assert.equal(capture.body.browser, "Chrome");
  assert.equal(capture.body.avatar, "android");
});

test("presence stores a validated avatar and publishes the profile fields", async () => {
  const state = new FakeState();
  const presence = new Presence(state);
  const { body, status } = await register(presence, {
    deviceId: "device-alpha-1234",
    name: "Alpha",
    deviceType: "Mobile",
    platform: "Android",
    browser: "Chrome",
    avatar: "../../evil.svg",
  });
  assert.equal(status, 200);
  const record = presence.peers[body.peerId];
  assert.equal(record.avatar, "generic");
  assert.equal(record.platform, "Android");
  assert.equal(record.browser, "Chrome");

  record.connected = true;
  const socket = new FakeSocket();
  socket.serializeAttachment({ peerId: body.peerId });
  state.acceptWebSocket(socket, [body.peerId]);
  await message(presence, socket, { type: "refresh" });
  const peer = socket.sent.at(-1).peers.find((entry) => entry.peerId === body.peerId);
  assert.equal(peer.avatar, "generic");
  assert.equal(peer.platform, "Android");
  assert.equal(peer.browser, "Chrome");
  assert.equal("tokenHash" in peer, false);
});

test("the same network address maps to the same presence group", async () => {
  const first = {};
  const second = {};
  const request = () =>
    new Request("https://worker.dev/api/nearby/register", {
      method: "POST",
      headers: { origin: PROD, "content-type": "application/json", "cf-connecting-ip": "198.51.100.4" },
      body: JSON.stringify({ deviceId: "device-alpha-1234", name: "A" }),
    });

  await worker.fetch(request(), workerEnv(first));
  await worker.fetch(request(), workerEnv(second));
  assert.equal(first.group, second.group);
});

test("nearby registration rejects invalid identities and foreign origins", async () => {
  const capture = {};
  const bad = await worker.fetch(
    new Request("https://worker.dev/api/nearby/register", {
      method: "POST",
      headers: { origin: PROD, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "no", name: "A" }),
    }),
    workerEnv(capture),
  );
  assert.equal(bad.status, 400);

  const foreign = await worker.fetch(
    new Request("https://worker.dev/api/nearby/register", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-alpha-1234", name: "A" }),
    }),
    workerEnv(capture),
  );
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, "origin_rejected");
  assert.equal(capture.url, undefined, "a rejected origin never reaches the Durable Object");
});

test("the nearby socket requires a WebSocket upgrade", async () => {
  const response = await worker.fetch(
    new Request("https://worker.dev/api/nearby/socket?token=abc", {
      headers: { origin: PROD },
    }),
    workerEnv({}),
  );
  assert.equal(response.status, 426);

  const noToken = await worker.fetch(
    new Request("https://worker.dev/api/nearby/socket", {
      headers: { origin: PROD, upgrade: "websocket" },
    }),
    workerEnv({}),
  );
  assert.equal(noToken.status, 401);
});
