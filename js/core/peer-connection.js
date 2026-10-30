/**
 * RTCPeerConnection lifecycle for Droply.
 *
 * The sender is always the offerer and creates the data channel; the receiver
 * answers. Remote ICE candidates that arrive before the remote description are
 * buffered, which is required because signaling messages can overtake the SDP.
 */

import { sanitizeIceCandidate } from "../utils/validation.js";

export class PeerConnection extends EventTarget {
  /**
   * @param {{ role: "sender"|"receiver", iceServers: RTCIceServer[] }} options
   */
  constructor({ role, iceServers }) {
    super();
    this.role = role;
    this.closed = false;
    /** @type {RTCIceCandidateInit[]} */
    this.pendingCandidates = [];
    this.hasRemoteDescription = false;

    this.pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });

    this.pc.addEventListener("icecandidate", (event) => {
      this.dispatchEvent(
        new CustomEvent("icecandidate", {
          detail: { candidate: event.candidate ? event.candidate.toJSON() : null },
        }),
      );
    });

    this.pc.addEventListener("connectionstatechange", () => {
      this.dispatchEvent(
        new CustomEvent("statechange", {
          detail: {
            connectionState: this.pc.connectionState,
            iceConnectionState: this.pc.iceConnectionState,
            iceGatheringState: this.pc.iceGatheringState,
          },
        }),
      );
    });

    this.pc.addEventListener("iceconnectionstatechange", () => {
      this.dispatchEvent(
        new CustomEvent("icestatechange", {
          detail: { iceConnectionState: this.pc.iceConnectionState },
        }),
      );
    });

    this.pc.addEventListener("datachannel", (event) => {
      this.dispatchEvent(new CustomEvent("datachannel", { detail: { channel: event.channel } }));
    });

    this.pc.addEventListener("track", () => {
      /* Droply does not use media tracks. */
    });
  }

  /**
   * Sender-only: creates the reliable, ordered file transport channel.
   * @param {string} label
   */
  createDataChannel(label = "droply-files") {
    return this.pc.createDataChannel(label, {
      ordered: true,
      // Reliability with retransmits: file bytes must never be dropped.
      maxRetransmits: undefined,
      maxPacketLifeTime: undefined,
    });
  }

  /** @returns {Promise<RTCSessionDescriptionInit>} */
  async createOffer(options = {}) {
    const offer = await this.pc.createOffer({
      iceRestart: Boolean(options.iceRestart),
    });
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription;
  }

  /** Receiver: applies the sender's offer and returns our answer. */
  async acceptOffer(offer) {
    await this.#setRemote(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.pc.localDescription;
  }

  /** Sender: applies the receiver's answer. */
  async acceptAnswer(answer) {
    await this.#setRemote(answer);
  }

  async #setRemote(description) {
    if (!description || typeof description.sdp !== "string" || description.type === undefined) {
      throw new Error("Received an invalid session description.");
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(description));
    this.hasRemoteDescription = true;
    await this.#flushCandidates();
  }

  /**
   * Adds a remote ICE candidate, buffering it until the remote description
   * exists. Ignore failures: a dead candidate is normal during ICE.
   * @param {unknown} candidate
   */
  async addRemoteCandidate(candidate) {
    const sanitized = sanitizeIceCandidate(candidate);
    if (!sanitized) return;
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(sanitized);
      return;
    }
    try {
      await this.pc.addIceCandidate(sanitized);
    } catch (error) {
      console.warn("[webrtc] could not add remote candidate", error?.message);
    }
  }

  async #flushCandidates() {
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("[webrtc] could not add buffered candidate", error?.message);
      }
    }
  }

  /**
   * Reads the selected candidate pair so the UI can honestly say whether the
   * transfer is direct or relayed through TURN.
   * @returns {Promise<{ path: "direct"|"relayed"|"unknown", localType: string|null, remoteType: string|null }>}
   */
  async describePath() {
    try {
      const report = await this.pc.getStats();
      /** @type {Map<string, RTCStats>} */
      const stats = new Map();
      report.forEach((entry) => stats.set(entry.id, entry));

      let pair = null;
      report.forEach((entry) => {
        if (entry.type === "transport" && entry.selectedCandidatePairId) {
          pair = stats.get(entry.selectedCandidatePairId) ?? pair;
        }
      });
      if (!pair) {
        report.forEach((entry) => {
          if (
            entry.type === "candidate-pair" &&
            (entry.state === "succeeded" || entry.nominated) &&
            entry.bytesReceived + entry.bytesSent > 0
          ) {
            pair = entry;
          }
        });
      }
      if (!pair) return { path: "unknown", localType: null, remoteType: null };

      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const localType = local?.candidateType ?? null;
      const remoteType = remote?.candidateType ?? null;
      const relayed = localType === "relay" || remoteType === "relay";
      return { path: relayed ? "relayed" : "direct", localType, remoteType };
    } catch {
      return { path: "unknown", localType: null, remoteType: null };
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pendingCandidates = [];
    try {
      this.pc.getSenders().forEach((sender) => sender.track?.stop());
      this.pc.close();
    } catch {
      /* ignore double close */
    }
    this.dispatchEvent(new CustomEvent("statechange", {
      detail: { connectionState: this.pc.connectionState, iceConnectionState: "closed" },
    }));
  }
}

/** Feature detection used before we let the user start a transfer. */
export function isWebRtcSupported() {
  return (
    typeof window.RTCPeerConnection === "function" &&
    typeof window.RTCSessionDescription === "function" &&
    typeof window.RTCIceCandidate === "function" &&
    "createDataChannel" in RTCPeerConnection.prototype
  );
}
