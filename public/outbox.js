// A judge's score that has been sent but not yet confirmed by the server.
// Pure decisions only (no DOM, no sockets), shared by both judge pads and
// unit-tested in test/outbox.test.js.
//
// The pad keeps one pending score: { seq, value, ref, sentAt, firstSentAt }. It is cleared
// when the server acks it, or when a state shows the judge's score already
// equals it. If no ack arrives within ACK_TIMEOUT_MS the connection is treated
// as dead: the pad reconnects and re-sends after the next state.

export const ACK_TIMEOUT_MS = 3000;
// A pending score older than this is not restored after a page reload.
export const MAX_RESTORE_AGE_MS = 10 * 60 * 1000;

// What to do with `pending` given the latest state for this judge.
//   "none"   – nothing pending
//   "done"   – the server already has this score; clear it
//   "drop"   – the dive moved on or was locked; clear it, it can't be sent
//   "resend" – still open and not recorded; send it again
export function reconcile(pending, current) {
  if (!pending) return "none";
  if (!current || current.seq !== pending.seq) return "drop";
  if (current.myScore === pending.value) return "done";
  if (current.phase !== "scoring") return "drop";
  return "resend";
}

// Status line under the score while it is pending.
export function pendingStatus(pending, { online, now }) {
  if (!pending) return "";
  if (!online) return "Not sent yet · will send when reconnected";
  // Timed from the first attempt: retries after a reconnect don't reset it.
  if (now - (pending.firstSentAt ?? pending.sentAt ?? now) > ACK_TIMEOUT_MS) return "Not confirmed · reconnecting…";
  return "Sending…";
}

// A pending score saved before a reload, if it is still worth restoring.
export function restorable(saved, now) {
  if (!saved || typeof saved !== "object") return null;
  if (!Number.isFinite(saved.seq) || !Number.isFinite(saved.value)) return null;
  if (!(now - (saved.savedAt ?? 0) < MAX_RESTORE_AGE_MS)) return null;
  return { seq: saved.seq, value: saved.value, ref: saved.ref, sentAt: 0 };
}
