import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateVerdicts,
  dedupeFindings,
  downgradeVerdictsForCoverage,
  computeQuorum
} from "../../scripts/lib/aggregate.mjs";

test("dedupeFindings merges identical findings by (filePath, lineRange, category, descriptionDigest)", () => {
  const findings = [
    {
      reviewer: "r1",
      filePath: "src/a.js",
      lineRange: [10, 12],
      category: "bug",
      detail: "Possible null deref"
    },
    {
      reviewer: "r2",
      filePath: "src/a.js",
      lineRange: [10, 12],
      category: "bug",
      detail: "Possible null deref"
    },
    {
      reviewer: "r1",
      filePath: "src/a.js",
      lineRange: [14, 16],
      category: "bug",
      detail: "Other issue"
    }
  ];
  const deduped = dedupeFindings(findings);
  assert.equal(deduped.length, 2);
  const merged = deduped.find((entry) => entry.detail === "Possible null deref");
  assert.deepEqual(merged.mergedFrom.sort(), ["r1", "r2"]);
});

test("downgradeVerdictsForCoverage converts GREEN to YELLOW when artifacts were not read", () => {
  const verdicts = [
    {
      reviewer: "r1",
      verdict: "GREEN",
      coverageComplete: true,
      touched_files: ["a.md"],
      findings: []
    }
  ];
  const adjusted = downgradeVerdictsForCoverage(verdicts, ["a.md", "b.md"]);
  assert.equal(adjusted[0].verdict, "YELLOW");
  assert.equal(adjusted[0].coverageComplete, false);
  assert.ok(adjusted[0].findings.some((finding) => finding.category === "coverage_incomplete"));
});

test("aggregateVerdicts yields GREEN when quorum is met and no issues are present", () => {
  const result = aggregateVerdicts(
    [
      { reviewer: "r1", verdict: "GREEN", coverageComplete: true, touched_files: ["x"], findings: [] },
      { reviewer: "r2", verdict: "GREEN", coverageComplete: true, touched_files: ["x"], findings: [] },
      { reviewer: "r3", verdict: "GREEN", coverageComplete: true, touched_files: ["x"], findings: [] }
    ],
    { requiredArtifacts: ["x"] }
  );
  assert.equal(result.verdict, "GREEN");
  assert.equal(result.coverageComplete, true);
  assert.equal(result.counts.GREEN, 3);
});

test("aggregateVerdicts returns RED when any reviewer is RED", () => {
  const result = aggregateVerdicts(
    [
      { reviewer: "r1", verdict: "GREEN", coverageComplete: true, touched_files: ["x"], findings: [] },
      { reviewer: "r2", verdict: "RED", coverageComplete: true, touched_files: ["x"], findings: [] }
    ],
    { requiredArtifacts: ["x"] }
  );
  assert.equal(result.verdict, "RED");
});

test("aggregateVerdicts falls back to INCONCLUSIVE when eligibleCount < quorum", () => {
  const result = aggregateVerdicts(
    [
      { reviewer: "r1", verdict: "GREEN", coverageComplete: true, findings: [] },
      { reviewer: "r2", verdict: "GREEN", coverageComplete: false, findings: [] },
      { reviewer: "r3", verdict: "GREEN", coverageComplete: false, findings: [] }
    ],
    {}
  );
  assert.equal(result.verdict, "INCONCLUSIVE");
});

test("aggregateVerdicts emits a synthetic coverage_incomplete meta finding for excluded reviewers", () => {
  const result = aggregateVerdicts(
    [
      { reviewer: "r1", verdict: "GREEN", coverageComplete: true, findings: [] },
      { reviewer: "r2", verdict: "GREEN", coverageComplete: false, findings: [] }
    ],
    {}
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.category === "coverage_incomplete" && finding.reviewer === "r2"
    )
  );
});

test("computeQuorum uses ceil(n * 2 / 3) with a floor of 1", () => {
  assert.equal(computeQuorum(1), 1);
  assert.equal(computeQuorum(3), 2);
  assert.equal(computeQuorum(5), 4);
});

test("aggregateVerdicts honors judgement.label when present (plan §17.1.1)", () => {
  const result = aggregateVerdicts(
    [
      {
        reviewer: "r1",
        verdict: "GREEN",
        judgement: { label: "RED", reason: "spec gap" },
        coverageComplete: true,
        touched_files: ["x"],
        findings: []
      }
    ],
    { requiredArtifacts: ["x"] }
  );
  assert.equal(result.verdict, "RED");
});

test("dedupeFindings folds rich description/suggestion fields into the digest", () => {
  const findings = [
    {
      reviewer: "r1",
      filePath: "src/a.js",
      lineRange: [10, 12],
      category: "bug",
      description: "Null dereference on user.profile",
      suggestion: "Guard with optional chaining."
    },
    {
      reviewer: "r2",
      filePath: "src/a.js",
      lineRange: [10, 12],
      category: "bug",
      description: "Null dereference on user.profile",
      suggestion: "Guard with optional chaining."
    }
  ];
  const deduped = dedupeFindings(findings);
  assert.equal(deduped.length, 1);
  assert.deepEqual(deduped[0].mergedFrom.sort(), ["r1", "r2"]);
});
