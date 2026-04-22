import test from "node:test";
import assert from "node:assert/strict";

import { validate } from "../../scripts/lib/schema.mjs";

test("state schema accepts a minimal valid state", async () => {
  const result = await validate("mavsdd-state", {
    feature: "sample",
    phase: "planned"
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("state schema rejects unknown phase", async () => {
  const result = await validate("mavsdd-state", {
    feature: "sample",
    phase: "flying"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /enum/.test(error.message)));
});

test("team-composition schema requires units with id/role", async () => {
  const missing = await validate("mavsdd-team-composition", {
    feature: "x",
    units: [{ id: "u1" }]
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((error) => /role/.test(error.message)));

  const ok = await validate("mavsdd-team-composition", {
    feature: "x",
    units: [
      {
        id: "u1",
        role: "implementer",
        writePaths: ["src/"],
        writeFiles: [],
        readPaths: ["src/"],
        readFiles: [],
        verificationTier: "tier0"
      }
    ]
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

test("operations schema validates add / overwrite / delete / rename / chmod", async () => {
  const manifest = {
    feature: "f",
    unitId: "u1",
    changedPaths: ["src/a.js", "src/b.js"],
    requirementCoverage: ["REQ-2", "REQ-6"],
    operations: [
      { op: "add", path: "src/a.js", contentHash: "h", requirementRefs: ["REQ-2"] },
      { op: "overwrite", path: "src/b.js", baseHash: "b", contentHash: "h", requirementRefs: ["REQ-6"] },
      { op: "delete", path: "src/c.js", baseHash: "b" },
      { op: "rename", from: "src/d.js", to: "src/e.js", baseHash: "b" },
      { op: "chmod", path: "src/f.js", baseHash: "b", mode: 493 }
    ]
  };
  const result = await validate("mavsdd-operations", manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const bad = await validate("mavsdd-operations", {
    feature: "f",
    unitId: "u1",
    operations: [{ op: "nope", path: "src/a.js" }]
  });
  assert.equal(bad.valid, false);
});

test("verdict schema accepts a minimal valid verdict", async () => {
  const result = await validate("mavsdd-verdict", {
    verdict: "GREEN",
    findings: []
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const bad = await validate("mavsdd-verdict", { verdict: "BLUE", findings: [] });
  assert.equal(bad.valid, false);
});

test("finding schema rejects findings without an id or severity", async () => {
  const bad = await validate("mavsdd-finding", { title: "missing id" });
  assert.equal(bad.valid, false);

  const ok = await validate("mavsdd-finding", {
    id: "FIND-1",
    severity: "high",
    title: "missing dep"
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

test("finding schema accepts plan §17.1.1 rich fields (findingId / routeTo / description / suggestion)", async () => {
  const result = await validate("mavsdd-finding", {
    findingId: "f-42",
    severity: "medium",
    blocking: false,
    category: "test_coverage",
    routeTo: "tester",
    title: "Missing fractional-average assertion",
    description: "describeRange(0,1) is not asserted for average=0.5.",
    suggestion: "Add an explicit test case.",
    filePath: "tests/range.test.js",
    lineRange: [40, 55]
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("verdict schema accepts a richly-populated report (plan §17.1.1)", async () => {
  const result = await validate("mavsdd-verdict", {
    schemaVersion: "1.0",
    reviewerId: "reviewer-1",
    scope: "plan",
    iteration: 1,
    snapshotId: "plan-iteration-1",
    model: "gpt-5.4",
    resolvedModel: "gpt-5.4",
    provider: "openai-responses",
    effort: "high",
    promptPayloadHash: "sha256:abcd",
    summary: "Plan needs tighter validation split.",
    verdict: "YELLOW",
    coverageComplete: true,
    touched_files: ["plan.md"],
    evaluation: {
      architecture: 0.9,
      testability: 0.7,
      operability: 0.8,
      evidencePaths: ["/abs/plan.md"]
    },
    judgement: { label: "YELLOW", reason: "Non-blocking gaps." },
    recommendedAction: "revise_then_re-review",
    confidence: "high",
    readSetProducer: "trusted-cli-preload",
    readSetRef: ".mavsdd/.../read-set.jsonl",
    artifactDigestsRef: ".mavsdd/.../artifact-digests.json",
    findings: [
      {
        findingId: "f-1",
        severity: "medium",
        routeTo: "planner",
        title: "spec gap",
        description: "REQ-1 too broad",
        suggestion: "split into sub-requirements"
      }
    ]
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
