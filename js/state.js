/**
 * Session state for one transfer. Intentionally in-memory only: Droply keeps
 * no history, no storage of file contents and no identifiers across reloads.
 */

const listeners = new Set();

function createInitialState() {
  return {
    /** @type {"sender"|"receiver"|null} */
    role: null,
    /** Six-character room code. */
    code: null,
    /** ISO timestamp from the signaling server. */
    expiresAt: null,
    /** Short-lived role token (kept in memory only). */
    token: null,
    /** @type {File[]} */
    files: [],
    /** @type {"idle"|"waiting"|"joining"|"negotiating"|"connecting"|"connected"|"waiting-accept"|"transferring"|"completed"|"failed"|"cancelled"} */
    phase: "idle",
    /** @type {{ sentBytes: number, receivedBytes: number, totalBytes: number }|null} */
    progress: null,
  };
}

export const session = createInitialState();

/** Subscribes to session changes. Returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Merges a patch into the session and notifies subscribers. */
export function setSession(patch) {
  Object.assign(session, patch);
  for (const listener of listeners) listener(session);
}

/** Clears everything that belongs to the finished transfer. */
export function resetSession() {
  const fresh = createInitialState();
  for (const key of Object.keys(session)) delete session[key];
  Object.assign(session, fresh);
  for (const listener of listeners) listener(session);
}

/** True when a transfer is in a state that must not be navigated away from. */
export function isActive() {
  return ["waiting", "joining", "negotiating", "connecting", "connected", "waiting-accept", "transferring"].includes(
    session.phase,
  );
}
