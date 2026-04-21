import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASES,
  PHASE_TRANSITIONS,
  isTransitionAllowed,
  assertTransition
} from "../../scripts/lib/mavsdd-core.mjs";

test("PHASES contains every plan-required explicit phase", () => {
  const required = [
    "initialized",
    "planned",
    "plan_review_pending",
    "plan_reviewed",
    "plan_review_inconclusive",
    "plan_approved",
    "red",
    "implementing",
    "implemented",
    "ready_to_stage",
    "staged",
    "impl_applying",
    "applied",
    "verifying",
    "verified",
    "impl_review_pending",
    "impl_reviewed",
    "impl_review_inconclusive",
    "fix_required",
    "blocked",
    "done"
  ];
  for (const phase of required) {
    assert.ok(PHASES.includes(phase), `missing phase ${phase}`);
  }
});

test("PHASE_TRANSITIONS forms an acyclic flow from initialized to done", () => {
  assert.deepEqual(PHASE_TRANSITIONS.initialized, ["planned"]);
  assert.ok(PHASE_TRANSITIONS.fix_required.includes("implementing"));
  assert.ok(PHASE_TRANSITIONS.fix_required.includes("blocked"));
  assert.deepEqual(PHASE_TRANSITIONS.done, []);
});

test("isTransitionAllowed permits documented transitions and rejects unknown jumps", () => {
  assert.equal(isTransitionAllowed("planned", "plan_review_pending"), true);
  assert.equal(isTransitionAllowed("verified", "impl_review_pending"), true);
  assert.equal(isTransitionAllowed("red", "done"), false);
  assert.equal(isTransitionAllowed("initialized", "done"), false);
  assert.equal(isTransitionAllowed("blocked", "implementing"), true);
  assert.equal(isTransitionAllowed("done", "implementing"), false);
});

test("assertTransition throws with a clear error for invalid hops", () => {
  assert.throws(
    () => assertTransition("initialized", "done"),
    /illegal phase transition/
  );
});
