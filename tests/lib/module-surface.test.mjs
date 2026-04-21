import test from "node:test";
import assert from "node:assert/strict";

test("state.mjs re-exports the feature-state primitives", async () => {
  const module = await import("../../scripts/lib/state.mjs");
  assert.equal(typeof module.loadState, "function");
  assert.equal(typeof module.saveState, "function");
  assert.equal(typeof module.createFeatureState, "function");
  assert.equal(Array.isArray(module.PHASES), true);
});

test("workspace.mjs re-exports materialize + verification helpers", async () => {
  const module = await import("../../scripts/lib/workspace.mjs");
  assert.equal(typeof module.materializeWorkspaces, "function");
  assert.equal(typeof module.runVerification, "function");
});

test("clusters.mjs re-exports fixer workflow primitives", async () => {
  const module = await import("../../scripts/lib/clusters.mjs");
  assert.equal(typeof module.prepareFixes, "function");
  assert.equal(typeof module.runFixWorkflow, "function");
  assert.equal(typeof module.approveOrphanCluster, "function");
});

test("codex-prompt.mjs re-exports the review / implementation entry points", async () => {
  const module = await import("../../scripts/lib/codex-prompt.mjs");
  assert.equal(typeof module.runReview, "function");
  assert.equal(typeof module.runClaudeImplementation, "function");
});
