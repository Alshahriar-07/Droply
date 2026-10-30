/**
 * Guards the 5 GB transfer ceiling: one file and the whole selection are both
 * capped at 5,368,709,120 bytes, and the receiver validates the same numbers in
 * the manifest it gets from the sender.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GiB = 1024 ** 3;
const FIVE_GB = 5 * GiB;

// js/config.js reads window/document at import time.
globalThis.window = {
  location: {
    origin: "https://droply-files.vercel.app",
    hostname: "droply-files.vercel.app",
    protocol: "https:",
    pathname: "/",
    search: "",
  },
  isSecureContext: true,
  setTimeout,
  clearTimeout,
};
globalThis.document = { querySelector: () => null };

const { config } = await import(pathToFileURL(path.join(ROOT, "js/config.js")).href);
const { assertLocalFilesAreSendable, validateManifestFiles } = await import(
  pathToFileURL(path.join(ROOT, "js/utils/validation.js")).href
);

/** A duck-typed File: validation only reads name, size and type. */
const sized = (name, size, type = "application/octet-stream") => ({ name, size, type });

test("configured limits are 5 GiB for a file and for the transfer", () => {
  assert.equal(FIVE_GB, 5368709120);
  assert.equal(config.maxFileBytes, 5368709120);
  assert.equal(config.maxTotalBytes, 5368709120);
});

test("a file of exactly 5 GB is accepted", () => {
  assert.equal(assertLocalFilesAreSendable([sized("big.bin", FIVE_GB)]), FIVE_GB);
});

test("a file larger than 5 GB is rejected with the limit in the message", () => {
  assert.throws(
    () => assertLocalFilesAreSendable([sized("too-big.bin", FIVE_GB + 1)]),
    (error) => {
      assert.equal(error.code, "file/too-large");
      assert.match(error.message, /5 GB per-file limit/);
      return true;
    },
  );
});

test("several files that add up to more than 5 GB are rejected", () => {
  const files = [sized("a.bin", 2 * GiB), sized("b.bin", 2 * GiB), sized("c.bin", 2 * GiB)];
  assert.throws(
    () => assertLocalFilesAreSendable(files),
    (error) => {
      assert.equal(error.code, "file/too-large");
      assert.match(error.message, /5 GB per-transfer limit/);
      return true;
    },
  );
});

test("a manifest at the limit is accepted and one byte over is rejected", () => {
  const ok = validateManifestFiles([{ id: "f0", name: "big.bin", size: FIVE_GB, type: "" }]);
  assert.equal(ok.totalBytes, FIVE_GB);

  assert.throws(
    () => validateManifestFiles([{ id: "f0", name: "big.bin", size: FIVE_GB + 1, type: "" }]),
    /5 GB limit/,
  );
});

test("a manifest whose files exceed the transfer limit is rejected", () => {
  assert.throws(
    () =>
      validateManifestFiles([
        { id: "f0", name: "a.bin", size: 2 * GiB, type: "" },
        { id: "f1", name: "b.bin", size: 2 * GiB, type: "" },
        { id: "f2", name: "c.bin", size: 2 * GiB, type: "" },
      ]),
    /5 GB limit/,
  );
});
