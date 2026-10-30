/**
 * Droply transfer protocol (v1).
 *
 * Control messages are JSON text frames. File bytes are binary frames with an
 * 11-byte header so the receiver can validate ordering and length without
 * guessing. The channel is reliable + ordered, so a single sequential stream
 * per file is enough — no per-chunk acknowledgements are required.
 *
 *   byte 0        frame type (1 = chunk)
 *   bytes 1..2    file index (uint16, big endian)
 *   bytes 3..6    sequence number within the file (uint32, big endian)
 *   bytes 7..10   payload length in bytes (uint32, big endian)
 *   bytes 11..    payload
 */

import { validateManifestFiles, sanitizeIceCandidate } from "../utils/validation.js";
import { parseDeviceMetadata } from "./device-profile.js";

export const PROTOCOL_VERSION = 1;

/** Binary frame types. */
export const FRAME = Object.freeze({
  CHUNK: 0x01,
});

export const CHUNK_HEADER_BYTES = 11;

/** Control message types exchanged over the data channel. */
export const CONTROL = Object.freeze({
  /** Receiver -> sender: public device profile, sent as soon as the channel opens. */
  HELLO: "hello",
  MANIFEST: "manifest",
  ACCEPT: "accept",
  REJECT: "reject",
  FILE_START: "file-start",
  FILE_END: "file-end",
  COMPLETE: "complete",
  /** Receiver -> sender: every byte arrived and was verified. */
  CONFIRMED: "confirmed",
  CANCEL: "cancel",
  ERROR: "error",
});

/** Human readable reasons sent with `cancel`. */
export const CANCEL_REASON = Object.freeze({
  SENDER_CANCELLED: "sender-cancelled",
  RECEIVER_REJECTED: "receiver-rejected",
  RECEIVER_CANCELLED: "receiver-cancelled",
  PEER_LEFT: "peer-left",
  PROTOCOL_ERROR: "protocol-error",
});

export const MAX_CONTROL_BYTES = 64 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

/* --------------------------------------------------------------------------
   Binary chunk framing
   -------------------------------------------------------------------------- */

/**
 * @param {number} fileIndex
 * @param {number} sequence
 * @param {Uint8Array} payload
 * @returns {ArrayBuffer}
 */
export function encodeChunk(fileIndex, sequence, payload) {
  if (payload.byteLength > MAX_CHUNK_BYTES) {
    throw new ProtocolError("Chunk exceeds the maximum allowed size.");
  }
  const buffer = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, FRAME.CHUNK);
  view.setUint16(1, fileIndex);
  view.setUint32(3, sequence);
  view.setUint32(7, payload.byteLength);
  new Uint8Array(buffer, CHUNK_HEADER_BYTES).set(payload);
  return buffer;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{ fileIndex: number, sequence: number, payload: Uint8Array }}
 */
export function decodeChunk(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= CHUNK_HEADER_BYTES) {
    throw new ProtocolError("Received an empty or truncated chunk.");
  }
  const view = new DataView(buffer);
  if (view.getUint8(0) !== FRAME.CHUNK) {
    throw new ProtocolError("Received an unknown binary frame.");
  }
  const fileIndex = view.getUint16(1);
  const sequence = view.getUint32(3);
  const length = view.getUint32(7);

  if (length > MAX_CHUNK_BYTES) {
    throw new ProtocolError("Chunk length exceeds the negotiated maximum.");
  }
  if (length !== buffer.byteLength - CHUNK_HEADER_BYTES) {
    throw new ProtocolError("Chunk length does not match its header.");
  }
  return {
    fileIndex,
    sequence,
    payload: new Uint8Array(buffer, CHUNK_HEADER_BYTES, length),
  };
}

/* --------------------------------------------------------------------------
   Control messages
   -------------------------------------------------------------------------- */

/** @param {Record<string, unknown>} message */
export function encodeControl(message) {
  return JSON.stringify({ ...message, v: PROTOCOL_VERSION });
}

/**
 * Parses and validates a control message from the peer.
 * @param {string} raw
 */
export function parseControl(raw) {
  if (typeof raw !== "string") throw new ProtocolError("Control message must be text.");
  if (raw.length > MAX_CONTROL_BYTES) throw new ProtocolError("Control message is too large.");

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new ProtocolError("Control message is not valid JSON.");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new ProtocolError("Control message must be an object.");
  }
  if (!Object.values(CONTROL).includes(message.t)) {
    throw new ProtocolError("Unknown control message type.");
  }
  return message;
}

/** Validates the sender's manifest and returns sanitised metadata. */
export function parseManifest(message) {
  if (message.t !== CONTROL.MANIFEST) throw new ProtocolError("Expected a manifest.");
  const { files, totalBytes } = validateManifestFiles(message.files);
  const declaredTotal = Number(message.totalBytes);
  if (Number.isFinite(declaredTotal) && declaredTotal !== totalBytes) {
    throw new ProtocolError("Manifest total does not match its files.");
  }
  // Device metadata is optional and strictly reduced to known public fields;
  // an invalid block is ignored rather than treated as a trusted identity.
  const peer = parseDeviceMetadata(message.peer);
  return { files, totalBytes, peer };
}

/** Narrow helpers used by the sender (kept here so both sides share shapes). */
export function fileStartMessage(index, file) {
  return { t: CONTROL.FILE_START, index, id: file.id, size: file.size };
}

export function fileEndMessage(index, bytes, chunks) {
  return { t: CONTROL.FILE_END, index, bytes, chunks };
}

export function cancelMessage(reason) {
  return { t: CONTROL.CANCEL, reason };
}

/** Only relay a candidate shape we understand. */
export function relayableCandidate(payload) {
  return sanitizeIceCandidate(payload?.candidate ?? payload);
}
