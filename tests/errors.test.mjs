/**
 * Error catalog and mapping tests.
 *
 * These run in plain Node (`node --test tests/`) and cover the parts of the
 * error system that can be verified without a browser: catalog integrity, the
 * signaling-code mapping, and the fallback behaviour the UI relies on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ERROR_ACTION,
  ERROR_CATALOG,
  ERROR_SCOPE,
  SIGNALING_ERROR_MAP,
  DEFAULT_ERROR_ID,
  createDiagnosticId,
  describeError,
  errorIdForSignalingCode,
  getErrorSpec,
  isCodeError,
  listErrorIds,
} from "../js/core/errors.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCOPES = new Set(Object.values(ERROR_SCOPE));
const ACTIONS = new Set(Object.values(ERROR_ACTION));

/** Icon names bundled in js/ui/icons.js, read from source (no DOM needed). */
function bundledIcons() {
  const source = fs.readFileSync(path.join(ROOT, "js/ui/icons.js"), "utf8");
  const block = source.slice(source.indexOf("const PATHS"), source.indexOf("};", source.indexOf("const PATHS")));
  return new Set([...block.matchAll(/^\s{2}"([a-z0-9-]+)":/gm)].map((match) => match[1]));
}

test("catalog ids and reference codes are unique", () => {
  const ids = listErrorIds();
  assert.ok(ids.length >= 25, `expected a broad catalog, got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length);

  const refs = ids.map((id) => ERROR_CATALOG[id].ref);
  assert.equal(new Set(refs).size, refs.length, "ref codes must be unique");
  for (const ref of refs) assert.match(ref, /^DL-[A-Z]+-\d{2}$/);
});

test("every entry has complete, user-facing copy", () => {
  for (const id of listErrorIds()) {
    const spec = ERROR_CATALOG[id];
    assert.ok(spec.title.length > 4, `${id}: title too short`);
    assert.ok(spec.message.length > 20, `${id}: message too short`);
    assert.ok(Array.isArray(spec.recovery) && spec.recovery.length > 0, `${id}: no recovery steps`);
    assert.ok(SCOPES.has(spec.scope), `${id}: unknown scope ${spec.scope}`);
    assert.equal(typeof spec.retryable, "boolean", `${id}: retryable must be boolean`);
    // Copy must stay human: no stack traces, no internals, no shouting.
    assert.doesNotMatch(spec.message, /\bat \w+ \(.*:\d+:\d+\)|TypeError|undefined|null/, `${id}: leaks internals`);
    assert.doesNotMatch(spec.title, /\b(ERROR|FAILED)\b/, `${id}: title is shouty`);
  }
});

test("every icon referenced by the catalog is bundled", () => {
  const icons = bundledIcons();
  assert.ok(icons.size > 30, "icon table looks unparsed");
  for (const id of listErrorIds()) {
    assert.ok(icons.has(ERROR_CATALOG[id].icon), `${id}: missing icon ${ERROR_CATALOG[id].icon}`);
  }
});

test("every action id is one the UI layer understands", () => {
  for (const id of listErrorIds()) {
    for (const action of ERROR_CATALOG[id].actions ?? []) {
      assert.ok(ACTIONS.has(action), `${id}: unknown action ${action}`);
    }
  }
});

test("signaling error codes map onto catalog entries", () => {
  for (const [code, id] of Object.entries(SIGNALING_ERROR_MAP)) {
    assert.ok(ERROR_CATALOG[id], `${code} maps to unknown id ${id}`);
  }

  const expectations = {
    room_not_found: "room/not-found",
    room_expired: "room/expired",
    room_occupied: "room/occupied",
    room_closed: "room/closed",
    invalid_code: "code/invalid",
    rate_limited: "signaling/rate-limited",
    network_error: "signaling/unreachable",
    // A 5xx is the service failing, not this browser being disallowed: it gets
    // its own catalog entry so the copy can say "try again" honestly.
    server_error: "signaling/error",
    bad_request: "signaling/rejected",
    origin_rejected: "signaling/rejected",
    invalid_offer: "signaling/rejected",
    invalid_answer: "signaling/rejected",
    invalid_candidate: "signaling/rejected",
    invalid_message: "signaling/rejected",
    unknown_type: "signaling/rejected",
  };
  for (const [code, id] of Object.entries(expectations)) {
    assert.equal(errorIdForSignalingCode(code), id, code);
  }
});

test("unknown signaling codes fall back instead of throwing", () => {
  for (const code of [undefined, null, "", "wat", "room_melted"]) {
    assert.equal(errorIdForSignalingCode(code), "signaling/unreachable");
  }
});

test("describeError normalises and never returns undefined", () => {
  const known = describeError("room/expired");
  assert.equal(known.id, "room/expired");
  assert.equal(known.ref, ERROR_CATALOG["room/expired"].ref);
  assert.ok(Array.isArray(known.actions));

  const unknown = describeError("does/not-exist");
  assert.equal(unknown.id, DEFAULT_ERROR_ID);
  assert.equal(unknown.title, ERROR_CATALOG[DEFAULT_ERROR_ID].title);

  const withDetail = describeError("connection/failed", { detail: "ICE failed" });
  assert.equal(withDetail.detail, "ICE failed");

  const withActions = describeError("connection/failed", { actions: ["home"] });
  assert.deepEqual(withActions.actions, ["home"]);
});

test("code errors are the ones shown beside the code input", () => {
  for (const id of ["room/not-found", "room/expired", "room/occupied", "room/closed", "code/invalid"]) {
    assert.ok(isCodeError(id), `${id} should be a code error`);
    assert.equal(getErrorSpec(id).scope, "inline", `${id} should render inline`);
  }
  assert.equal(isCodeError("connection/failed"), false);
});

test("retryable entries only promise what a retry can do", () => {
  // Codes that are dead for good must not claim another attempt will help.
  for (const id of ["room/not-found", "room/expired", "room/closed", "code/invalid", "code/incomplete"]) {
    assert.equal(ERROR_CATALOG[id].retryable, false, id);
  }
  // Transient transport failures are retryable.
  for (const id of ["network/offline", "signaling/unreachable", "connection/failed", "transfer/interrupted"]) {
    assert.equal(ERROR_CATALOG[id].retryable, true, id);
  }
});

test("page-scope errors only advertise actions the UI can wire", () => {
  const app = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
  const handlers = new Set(
    [...app.matchAll(/\[ERROR_ACTION\.([A-Z_]+)\]:/g)].map((match) => match[1]),
  );
  assert.ok(handlers.size >= 8, "expected the action map in app.js");

  const nameOf = (value) => Object.entries(ERROR_ACTION).find(([, id]) => id === value)?.[0];
  for (const id of listErrorIds()) {
    const spec = ERROR_CATALOG[id];
    if (spec.scope !== "page") continue;
    for (const action of spec.actions ?? []) {
      assert.ok(handlers.has(nameOf(action)), `${id} offers "${action}" but nothing handles it`);
    }
  }
});

test("diagnostic ids are short, random and carry no transfer data", () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = createDiagnosticId();
    assert.match(id, /^DL-[A-HJ-NP-Z2-9]{6}$/);
    seen.add(id);
  }
  assert.ok(seen.size > 190, "diagnostic ids should not repeat in practice");
});
