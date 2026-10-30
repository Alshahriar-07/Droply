/**
 * Sender engine: bounded reads, ordered chunk framing, backpressure and
 * cancellation. Proves that a 5 GB file is streamed in small slices rather
 * than read into memory, and that the send loop waits for the channel to
 * drain before queueing more bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FileSender } = await import(
  pathToFileURL(path.join(ROOT, "js/core/file-sender.js")).href
);
const { decodeChunk, MAX_CHUNK_BYTES, parseManifest } = await import(
  pathToFileURL(path.join(ROOT, "js/core/transfer-protocol.js")).href
);

const CHUNK = 32 * 1024;

/** A File-shaped object backed by a real byte array. */
function fakeFile(size, name = "big.bin", fill = (index) => index % 251) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = fill(index);
  const slices = [];
  return {
    name,
    size,
    type: "application/octet-stream",
    lastModified: 0,
    slices,
    slice(start, end) {
      slices.push({ start, end });
      const part = bytes.subarray(start, end);
      return { async arrayBuffer() { return part.slice().buffer; } };
    },
    arrayBuffer() {
      throw new Error("FileSender must never read the whole file at once");
    },
  };
}

function fakeTransport({ drainDelay = 0 } = {}) {
  return {
    controls: [],
    frames: [],
    drains: 0,
    isOpen: true,
    sendControl(message) {
      this.controls.push(message);
    },
    sendBinary(buffer) {
      this.frames.push(buffer);
    },
    async waitForDrain({ signal } = {}) {
      this.drains += 1;
      if (drainDelay) await new Promise((resolve) => setTimeout(resolve, drainDelay));
      if (signal?.aborted) throw new Error("Transfer cancelled.");
    },
  };
}

function collect(sender, type) {
  return new Promise((resolve, reject) => {
    sender.addEventListener(type, (event) => resolve(event.detail));
    sender.addEventListener("error", (event) => reject(new Error(event.detail?.message)));
  });
}

test("a multi-block file is streamed as ordered chunks with bounded reads", async () => {
  const size = 700 * 1024 + 7; // more than two read blocks, not a chunk multiple
  const file = fakeFile(size);
  const transport = fakeTransport();
  const sender = new FileSender({ transport, files: [file], chunkSize: CHUNK });
  sender.markAccepted();
  sender.sendManifest();

  const done = collect(sender, "complete");
  await sender.start();
  await done;

  const expectedChunks = Math.ceil(size / CHUNK);
  assert.equal(transport.frames.length, expectedChunks);

  let offset = 0;
  for (const [index, frame] of transport.frames.entries()) {
    const chunk = decodeChunk(frame);
    assert.equal(chunk.fileIndex, 0);
    assert.equal(chunk.sequence, index);
    assert.ok(chunk.payload.byteLength <= MAX_CHUNK_BYTES);
    assert.equal(chunk.payload[0], offset % 251);
    offset += chunk.payload.byteLength;
  }
  assert.equal(offset, size, "every byte is sent exactly once");

  assert.equal(transport.controls[0].t, "manifest");
  assert.equal(transport.controls[1].t, "file-start");
  assert.equal(transport.controls.at(-2).t, "file-end");
  assert.equal(transport.controls.at(-2).bytes, size);
  assert.equal(transport.controls.at(-2).chunks, expectedChunks);
  assert.equal(transport.controls.at(-1).t, "complete");
  assert.equal(transport.controls.at(-1).totalBytes, size);
});

test("the manifest carries a validated public profile to the receiver", () => {
  const transport = fakeTransport();
  const identity = {
    profile: {
      deviceId: "abcdefghijklmnop",
      name: "Windows-3141",
      deviceType: "Desktop",
      platform: "Windows",
      browser: "Chrome",
      avatar: "windows",
      suffix: "3141",
    },
  };
  const sender = new FileSender({ transport, files: [fakeFile(4)], identity });
  sender.sendManifest();

  const manifest = transport.controls[0];
  assert.equal(manifest.peer.name, "Windows-3141");
  const parsed = parseManifest(manifest);
  assert.deepEqual(parsed.peer, {
    deviceId: "abcdefghijklmnop",
    name: "Windows-3141",
    deviceType: "Desktop",
    platform: "Windows",
    browser: "Chrome",
    avatar: "windows",
    model: null,
  });
  assert.equal("suffix" in parsed.peer, false, "display-only extras are not trusted");
});

test("the channel is checked for backpressure before every chunk", async () => {
  const size = 12 * CHUNK;
  const transport = fakeTransport({ drainDelay: 1 });
  const sender = new FileSender({ transport, files: [fakeFile(size)], chunkSize: CHUNK });
  sender.markAccepted();

  await sender.start();

  assert.equal(transport.frames.length, 12);
  assert.equal(transport.drains, 12, "one drain wait per queued chunk");
});

test("no slice read is larger than one read block, so RAM stays bounded", async () => {
  const file = fakeFile(2 * 1024 * 1024);
  const transport = fakeTransport();
  const sender = new FileSender({ transport, files: [file], chunkSize: CHUNK });
  sender.markAccepted();

  await sender.start();

  assert.ok(file.slices.length >= 8, "the file is read in several blocks");
  for (const slice of file.slices) {
    assert.ok(slice.end - slice.start <= 256 * 1024, `block of ${slice.end - slice.start} bytes`);
    assert.ok(slice.end >= slice.start);
  }
});

test("progress is reported from bytes actually handed to the channel", async () => {
  const size = 20 * CHUNK;
  const transport = fakeTransport();
  const sender = new FileSender({ transport, files: [fakeFile(size)], chunkSize: CHUNK });
  sender.markAccepted();

  const updates = [];
  sender.addEventListener("progress", (event) => updates.push(event.detail));

  await sender.start();

  const last = updates.at(-1);
  assert.equal(last.transferredBytes, size);
  assert.equal(last.totalBytes, size);
  assert.equal(last.complete, true);
  assert.equal(last.files[0].state, "done");
});

test("multiple files keep their own boundaries and byte counts", async () => {
  const transport = fakeTransport();
  const files = [fakeFile(CHUNK * 2, "one.bin"), fakeFile(0, "empty.txt"), fakeFile(1000, "three.bin")];
  const sender = new FileSender({ transport, files, chunkSize: CHUNK });
  sender.markAccepted();

  await sender.start();

  assert.equal(sender.totalBytes, CHUNK * 2 + 1000);
  const starts = transport.controls.filter((message) => message.t === "file-start");
  assert.equal(starts.length, 3);
  assert.deepEqual(starts.map((message) => message.index), [0, 1, 2]);

  const ends = transport.controls.filter((message) => message.t === "file-end");
  assert.deepEqual(ends.map((message) => message.bytes), [CHUNK * 2, 0, 1000]);
  assert.equal(ends[1].chunks, 0, "an empty file sends no chunks and still completes");
});

test("cancelling stops the stream, notifies the peer and reports the reason", async () => {
  const file = fakeFile(256 * CHUNK);
  const transport = fakeTransport();
  let sender;
  // Cancel from inside the send loop, mid-file.
  transport.sendBinary = function sendBinary(buffer) {
    this.frames.push(buffer);
    if (this.frames.length === 4) sender.cancel("sender-cancelled");
  };
  sender = new FileSender({ transport, files: [file], chunkSize: CHUNK });
  sender.markAccepted();

  const cancelled = collect(sender, "cancelled");
  const running = sender.start();

  const detail = await cancelled;
  await running;

  assert.equal(detail.reason, "sender-cancelled");
  assert.ok(transport.frames.length < 256, "the loop stopped early");
  assert.ok(transport.controls.some((message) => message.t === "cancel"));
  assert.equal(transport.controls.some((message) => message.t === "complete"), false);
});

test("sending starts only after the receiver accepted", async () => {
  const sender = new FileSender({ transport: fakeTransport(), files: [fakeFile(10)] });
  await assert.rejects(() => sender.start(), /has not accepted/);
});
