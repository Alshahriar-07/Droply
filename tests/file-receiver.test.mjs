/**
 * The receiver folds chunks into Blob blocks instead of keeping every chunk in
 * a JS array, so a multi-GB file does not become a multi-GB heap allocation.
 * This feeds more than one 16 MB block through a fake channel to prove the
 * blocks are flushed, released, and reassembled into the exact byte count.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FileReceiver } = await import(pathToFileURL(path.join(ROOT, "js/core/file-receiver.js")).href);

const CHUNK = 32 * 1024;
const SIZE = 17 * 1024 * 1024 + 123; // more than one 16 MB flush block

function makePayload(sequence, length) {
  const bytes = new Uint8Array(length);
  bytes.fill(sequence % 251);
  return bytes;
}

function fakeTransport() {
  return {
    sent: [],
    isOpen: true,
    sendControl(message) {
      this.sent.push(message);
    },
  };
}

test("chunks are flushed into Blobs and the file is reassembled exactly", async () => {
  const transport = fakeTransport();
  const receiver = new FileReceiver({ transport });

  receiver.handleControl({
    t: "manifest",
    files: [{ id: "f0", name: "big.bin", size: SIZE, type: "application/octet-stream" }],
    totalBytes: SIZE,
    chunkSize: CHUNK,
  });
  receiver.accept();

  const chunks = Math.ceil(SIZE / CHUNK);
  let sent = 0;
  let flushedMidway = false;
  for (let sequence = 0; sequence < chunks; sequence += 1) {
    const length = Math.min(CHUNK, SIZE - sent);
    receiver.handleChunk({ fileIndex: 0, sequence, payload: makePayload(sequence, length) });
    sent += length;

    // After the first 16 MB block, the raw chunk list must already be small.
    if (!flushedMidway && sent > 16 * 1024 * 1024) {
      flushedMidway = true;
      const entry = receiver.entries[0];
      assert.ok(entry.blobs.length >= 1, "a 16 MB block should already be a Blob");
      assert.ok(
        entry.parts.length * CHUNK < 16 * 1024 * 1024,
        "buffered chunks should stay under one flush block",
      );
    }
  }

  const fileDone = new Promise((resolve) => receiver.addEventListener("file-complete", resolve));
  receiver.handleControl({ t: "file-end", index: 0, bytes: SIZE, chunks });
  const { detail } = await fileDone;

  assert.equal(receiver.entries[0].parts.length, 0, "chunk buffers are released");
  assert.equal(receiver.entries[0].pendingBytes, 0);
  assert.equal(detail.size, SIZE);

  const blob = receiver.entries[0].blob;
  assert.equal(blob.size, SIZE, "reassembled blob has every byte");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0, "first byte comes from the first chunk");
  assert.equal(bytes[SIZE - 1], (chunks - 1) % 251, "last byte comes from the last chunk");
  assert.equal(bytes[CHUNK], 1, "chunks are joined in order");

  const complete = new Promise((resolve) => receiver.addEventListener("complete", resolve));
  receiver.handleControl({ t: "complete", totalBytes: SIZE });
  await complete;
  assert.equal(receiver.state, "complete");
  assert.ok(
    transport.sent.some((message) => message.t === "confirmed"),
    "the receiver confirms the final byte count to the sender",
  );

  receiver.dispose();
});
