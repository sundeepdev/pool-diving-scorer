import { test } from "node:test";
import assert from "node:assert/strict";
import { ACK_TIMEOUT_MS, MAX_RESTORE_AGE_MS, pendingStatus, reconcile, restorable } from "../public/outbox.js";

const p = { seq: 7, value: 6.5, ref: 1, sentAt: 1000 };

test("nothing pending", () => {
  assert.equal(reconcile(null, { seq: 7, phase: "scoring", myScore: null }), "none");
});

test("server already has the score: done", () => {
  assert.equal(reconcile(p, { seq: 7, phase: "scoring", myScore: 6.5 }), "done");
  // the judge's score completed the panel and the dive auto-revealed
  assert.equal(reconcile(p, { seq: 7, phase: "revealed", myScore: 6.5 }), "done");
});

test("first score lost in a glitch: resend", () => {
  assert.equal(reconcile(p, { seq: 7, phase: "scoring", myScore: null }), "resend");
});

test("updated score lost in a glitch: resend (used to stay on 'Sending…')", () => {
  assert.equal(reconcile(p, { seq: 7, phase: "scoring", myScore: 6 }), "resend");
});

test("dive moved on or locked: drop", () => {
  assert.equal(reconcile(p, { seq: 8, phase: "scoring", myScore: null }), "drop");
  assert.equal(reconcile(p, { seq: 7, phase: "revealed", myScore: 6 }), "drop");
  assert.equal(reconcile(p, null), "drop");
});

test("status text says what is happening", () => {
  assert.equal(pendingStatus(null, { online: true, now: 0 }), "");
  assert.equal(pendingStatus(p, { online: true, now: 1000 + 100 }), "Sending…");
  assert.equal(pendingStatus(p, { online: true, now: 1000 + ACK_TIMEOUT_MS + 1 }), "Not confirmed · reconnecting…");
  assert.equal(pendingStatus(p, { online: false, now: 1000 }), "Not sent yet · will send when reconnected");
  // a retry after reconnecting doesn't make it look freshly sent again
  const retried = { ...p, firstSentAt: 1000, sentAt: 1000 + ACK_TIMEOUT_MS + 500 };
  assert.equal(pendingStatus(retried, { online: true, now: 1000 + ACK_TIMEOUT_MS + 600 }), "Not confirmed · reconnecting…");
});

test("restore after reload: only recent, well-formed scores", () => {
  const now = 5_000_000;
  assert.deepEqual(restorable({ seq: 7, value: 6.5, ref: 3, savedAt: now - 1000 }, now), { seq: 7, value: 6.5, ref: 3, sentAt: 0 });
  assert.equal(restorable({ seq: 7, value: 6.5, ref: 3, savedAt: now - MAX_RESTORE_AGE_MS - 1 }, now), null);
  assert.equal(restorable({ seq: "7", value: 6.5, savedAt: now }, now), null);
  assert.equal(restorable(null, now), null);
});
