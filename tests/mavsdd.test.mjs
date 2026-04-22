import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  aggregateReviews,
  approveOrphanCluster,
  applyOperations,
  createFeatureState,
  generatePlanArtifacts,
  generateRedArtifacts,
  loadEffectiveTeamComposition,
  materializeWorkspaces,
  prepareFixes,
  recordApproval,
  resumeSummary,
  runVerification,
  stageOperations,
  statusSummary,
  writeJson
} from "../scripts/lib/mavsdd-core.mjs";

test("init, plan, red, and resume create the expected runtime state", async () => {
  const repoRoot = await makeTempRepo();
  await createSampleTarget(repoRoot);
  await createFeatureState(repoRoot, "sample-feature", {
    target: "sample/sample-app",
    "verify-command": "npm test"
  });
  await generatePlanArtifacts(repoRoot, "sample-feature", {
    goal: "Add describeRange and sumRange"
  });
  await mockPlanApproval(repoRoot, "sample-feature");
  await generateRedArtifacts(repoRoot, "sample-feature");

  const status = await statusSummary(repoRoot, "sample-feature");
  const resume = await resumeSummary(repoRoot, "sample-feature");

  assert.equal(status.phase, "red");
  assert.equal(status.targetRepo, "sample/sample-app");
  assert.match(resume.nextCommand, /implement/);
  const requirements = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, ".mavsdd/features/sample-feature/specs/requirements-index.json"),
      "utf8"
    )
  ).requirements;
  const team = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, ".mavsdd/features/sample-feature/team-composition.json"),
      "utf8"
    )
  );
  // plan §0.4: v1 scaffold emits a single goal-derived REQ. Users expand
  // specs/requirements-index.json manually before plan-review. The default
  // team composition still exposes sample-audit for audit-heavy features.
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].id, "REQ-1");
  assert.match(requirements[0].summary, /Complete the feature as stated in the goal/);
  assert.ok(team.units.some((unit) => unit.id === "sample-logic"));
});

test("init accepts target-repo aliases for fresh sample apps", async () => {
  const repoRoot = await makeTempRepo();
  await createSampleTarget(repoRoot);
  const extraTarget = path.join(repoRoot, "sample/public-entrypoint-app");
  await fs.mkdir(path.join(extraTarget, "src"), { recursive: true });
  await fs.mkdir(path.join(extraTarget, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(extraTarget, "package.json"),
    `${JSON.stringify(
      {
        name: "public-entrypoint-app",
        type: "module",
        scripts: {
          test: "node --test"
        }
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(path.join(extraTarget, "src/index.js"), "export const ok = true;\n");
  await fs.writeFile(path.join(extraTarget, "tests/basic.test.js"), "import test from 'node:test';\n");

  const state = await createFeatureState(repoRoot, "alias-feature", {
    "target-repo": "sample/public-entrypoint-app",
    "verify-command": "npm test"
  });

  assert.equal(state.targetRepoRelative, "sample/public-entrypoint-app");
});

test("stage, apply, verify, and aggregate remain deterministic", async () => {
  const repoRoot = await makeTempRepo();
  await createSampleTarget(repoRoot);
  await createFeatureState(repoRoot, "sample-feature", {
    target: "sample/sample-app",
    "verify-command": "npm test"
  });
  await generatePlanArtifacts(repoRoot, "sample-feature");
  const planReviewDir = path.join(
    repoRoot,
    ".mavsdd/features/sample-feature/reviews/plan/iteration-1/reviewer-1"
  );
  await fs.mkdir(planReviewDir, { recursive: true });
  await writeJson(path.join(repoRoot, ".mavsdd/features/sample-feature/reviews/plan/iteration-1/manifest.json"), {
    feature: "sample-feature",
    scope: "plan",
    iteration: 1,
    artifactsToReview: []
  });
  await writeJson(path.join(repoRoot, ".mavsdd/features/sample-feature/reviews/plan/iteration-1/aggregate.json"), {
    feature: "sample-feature",
    scope: "plan",
    iteration: 1,
    verdict: "GREEN",
    coverageComplete: true,
    findings: [],
    counts: { GREEN: 1, YELLOW: 0, RED: 0 }
  });
  const planStatePath = path.join(repoRoot, ".mavsdd/features/sample-feature/feature-state.json");
  const planState = JSON.parse(await fs.readFile(planStatePath, "utf8"));
  planState.reviewIterations.plan = 1;
  await fs.writeFile(planStatePath, `${JSON.stringify(planState, null, 2)}\n`);
  await recordApproval(repoRoot, "sample-feature", "plan", { by: "tester" });
  await generateRedArtifacts(repoRoot, "sample-feature");
  const { root, repoDir } = await materializeWorkspaces(repoRoot, "sample-feature");

  await fs.writeFile(
    path.join(repoDir, "src/index.js"),
    [
      'export { describeRange, listRange, normalizeRange, sum, sumRange } from "./range.js";',
      ""
    ].join("\n")
  );

  await writeJson(path.join(root, "implementations/sample-logic/status.json"), {
    unit: "sample-logic",
    status: "implemented",
    updatedAt: new Date().toISOString(),
    changedFiles: ["src/index.js"]
  });
  await writeJson(path.join(root, "implementations/sample-tests/status.json"), {
    unit: "sample-tests",
    status: "unchanged",
    updatedAt: new Date().toISOString(),
    changedFiles: []
  });
  await writeJson(path.join(root, "implementations/sample-audit/status.json"), {
    unit: "sample-audit",
    status: "implemented",
    updatedAt: new Date().toISOString(),
    changedFiles: ["specs/reuse-evidence.md"]
  });
  await fs.writeFile(
    path.join(root, "specs/reuse-evidence.md"),
    [
      "# Reuse Evidence (REQ-7)",
      "",
      "Feature: `sample-feature`",
      "",
      "Owner unit: `sample-audit`",
      "",
      "## Checklist",
      "",
      "- [x] `sumRange(start, end)` delegates to `listRange` + `sum` (no duplicated loop over `start..end`).",
      "- [x] `describeRange(start, end)` delegates to `normalizeRange`, `listRange`, and `sum` for the aggregate (no re-computing the range walk).",
      "- [x] No new helpers re-implement `normalizeRange`'s validation logic locally.",
      "",
      "## Evidence",
      "",
      "- Diff reviewed: `operations/sample-logic/operations.json`",
      "- Supporting verification: `verification/summary.json` (PASS)",
      "- Reviewer: trusted-cli/sample-audit",
      "- Reviewed at: 2026-04-22T00:00:00.000Z",
      "- Conclusion: complete",
      ""
    ].join("\n")
  );

  const staged = await stageOperations(repoRoot, "sample-feature");
  assert.equal(staged.operationsByUnit["sample-logic"].length, 1);
  const logicOperations = JSON.parse(
    await fs.readFile(path.join(root, "operations/sample-logic/operations.json"), "utf8")
  );
  assert.deepEqual(logicOperations.changedPaths, ["src/index.js"]);
  assert.deepEqual(logicOperations.requirementCoverage, ["REQ-6"]);

  const applied = await applyOperations(repoRoot, "sample-feature");
  assert.equal(applied.appliedCount, 1);

  const verification = await runVerification(repoRoot, "sample-feature");
  assert.equal(verification.success, true);
  assert.equal(verification.overallVerdict, "PASS");
  assert.equal(verification.effectiveTier, "tier0");
  assert.equal(verification.commands.length, 1);

  const reviewDir = path.join(
    repoRoot,
    ".mavsdd/features/sample-feature/reviews/impl/iteration-1/reviewer-1"
  );
  await fs.mkdir(reviewDir, { recursive: true });
  await writeJson(
    path.join(
      repoRoot,
      ".mavsdd/features/sample-feature/reviews/impl/iteration-1/reviewer-1/verdict.json"
    ),
    {
      summary: "Looks good.",
      verdict: "GREEN",
      coverageComplete: true,
      findings: []
    }
  );

  const statePath = path.join(repoRoot, ".mavsdd/features/sample-feature/feature-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.reviewIterations.impl = 1;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const aggregate = await aggregateReviews(repoRoot, "sample-feature", "impl");
  assert.equal(aggregate.verdict, "GREEN");
  assert.equal(aggregate.coverageComplete, true);
});

test("orphan approval creates a patch overlay for temporary units", async () => {
  const repoRoot = await makeTempRepo();
  await createSampleTarget(repoRoot);
  await createFeatureState(repoRoot, "sample-feature", {
    target: "sample/sample-app",
    "verify-command": "npm test"
  });
  await generatePlanArtifacts(repoRoot, "sample-feature");

  const root = path.join(repoRoot, ".mavsdd/features/sample-feature");
  await writeJson(path.join(root, "reviews/impl/iteration-1/aggregate.json"), {
    feature: "sample-feature",
    scope: "impl",
    iteration: 1,
    verdict: "RED",
    coverageComplete: true,
    counts: { GREEN: 0, YELLOW: 0, RED: 1 },
    findings: [
      {
        reviewer: "reviewer-1",
        id: "FIND-1",
        severity: "high",
        title: "Cross-cutting issue",
        detail: "Artifact does not map to a known unit.",
        artifact: "docs/unknown.md",
        recommendation: "Create a temporary orphan fixer."
      }
    ]
  });
  const statePath = path.join(root, "feature-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.reviewIterations.impl = 1;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const fixResult = await prepareFixes(repoRoot, "sample-feature");
  assert.equal(fixResult.clusterCount, 1);

  const orphanDirs = await fs.readdir(path.join(root, "fixes/orphan"));
  assert.equal(orphanDirs.length, 1);

  await approveOrphanCluster(repoRoot, "sample-feature", {
    "cluster-id": orphanDirs[0],
    verdict: "approve",
    by: "tester"
  });

  const effectiveTeam = await loadEffectiveTeamComposition(repoRoot, "sample-feature");
  assert.equal(effectiveTeam.units.length, 4);
  assert.ok(effectiveTeam.patch);
  await fs.access(
    path.join(
      root,
      effectiveTeam.units.find((unit) => unit.originClusterId)?.briefPath
    )
  );
});

test("resume ignores obsolete plan reviewer jobs after verification", async () => {
  const repoRoot = await makeTempRepo();
  await createSampleTarget(repoRoot);
  await createFeatureState(repoRoot, "sample-feature", {
    target: "sample/sample-app",
    "verify-command": "npm test"
  });
  await generatePlanArtifacts(repoRoot, "sample-feature");

  const root = path.join(repoRoot, ".mavsdd/features/sample-feature");
  const statePath = path.join(root, "feature-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.phase = "verified";
  state.reviewIterations.plan = 1;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await writeJson(path.join(root, "team-runtime/reviewer-jobs.json"), [
    {
      scope: "plan",
      iteration: 1,
      reviewer: "reviewer-1",
      status: "failed"
    }
  ]);

  const resume = await resumeSummary(repoRoot, "sample-feature");
  assert.match(resume.nextCommand, /impl-review/);
  assert.equal(resume.pendingReviewers.length, 0);
});

test("prepareFixes excludes review_meta findings from actionable clusters", async () => {
  const repoRoot = await makeTempRepo();
  await createSampleTarget(repoRoot);
  await createFeatureState(repoRoot, "sample-feature", {
    target: "sample/sample-app",
    "verify-command": "npm test"
  });
  await generatePlanArtifacts(repoRoot, "sample-feature");

  const root = path.join(repoRoot, ".mavsdd/features/sample-feature");
  await writeJson(path.join(root, "reviews/impl/iteration-1/aggregate.json"), {
    feature: "sample-feature",
    scope: "impl",
    iteration: 1,
    verdict: "RED",
    coverageComplete: false,
    counts: { GREEN: 0, YELLOW: 0, RED: 1 },
    findings: [
      {
        reviewer: "reviewer-1",
        id: "FIND-meta",
        severity: "medium",
        title: "coverage_incomplete",
        detail: "Excluded from quorum.",
        artifact: "review_meta",
        recommendation: "Rerun reviewer."
      },
      {
        reviewer: "reviewer-1",
        id: "FIND-logic",
        severity: "high",
        title: "Logic issue",
        detail: "src/range.js needs changes.",
        artifact: "src/range.js",
        recommendation: "Fix the source."
      }
    ]
  });
  const statePath = path.join(root, "feature-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.reviewIterations.impl = 1;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const fixResult = await prepareFixes(repoRoot, "sample-feature");
  assert.equal(fixResult.clusterCount, 1);
});

test("approve gates conditional GREEN aggregates on --accept-risk (plan §0.2)", async () => {
  const repoRoot = await makeTempRepo();
  await createSampleTarget(repoRoot);
  await createFeatureState(repoRoot, "sample-feature", {
    target: "sample/sample-app",
    "verify-command": "npm test"
  });
  await generatePlanArtifacts(repoRoot, "sample-feature");

  const root = path.join(repoRoot, ".mavsdd/features/sample-feature");
  await fs.mkdir(path.join(root, "reviews/plan/iteration-1"), { recursive: true });
  await writeJson(path.join(root, "reviews/plan/iteration-1/manifest.json"), {
    feature: "sample-feature",
    scope: "plan",
    iteration: 1,
    artifactsToReview: []
  });
  // 2/3 GREEN + 1 RED → aggregate GREEN but conditional.
  await writeJson(path.join(root, "reviews/plan/iteration-1/aggregate.json"), {
    feature: "sample-feature",
    scope: "plan",
    iteration: 1,
    verdict: "GREEN",
    conditional: true,
    coverageComplete: true,
    counts: { GREEN: 2, YELLOW: 0, RED: 1 },
    findings: []
  });
  const statePath = path.join(root, "feature-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.phase = "plan_reviewed";
  state.reviewIterations.plan = 1;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    () => recordApproval(repoRoot, "sample-feature", "plan", { by: "tester" }),
    /accept-risk/
  );

  const approved = await recordApproval(repoRoot, "sample-feature", "plan", {
    by: "tester",
    "accept-risk": "1 reviewer RED but the risk is bounded — acknowledging."
  });
  assert.equal(approved.aggregateConditional, true);
  assert.match(approved.acceptRisk, /reviewer RED/);
});

async function makeTempRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-"));
}

async function mockPlanApproval(repoRoot, feature) {
  const iterationDir = path.join(
    repoRoot,
    `.mavsdd/features/${feature}/reviews/plan/iteration-1`
  );
  await fs.mkdir(iterationDir, { recursive: true });
  await writeJson(path.join(iterationDir, "manifest.json"), {
    feature,
    scope: "plan",
    iteration: 1,
    artifactsToReview: []
  });
  await writeJson(path.join(iterationDir, "aggregate.json"), {
    feature,
    scope: "plan",
    iteration: 1,
    verdict: "GREEN",
    coverageComplete: true,
    findings: [],
    counts: { GREEN: 1, YELLOW: 0, RED: 0 }
  });
  const statePath = path.join(repoRoot, `.mavsdd/features/${feature}/feature-state.json`);
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.reviewIterations.plan = 1;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await recordApproval(repoRoot, feature, "plan", { by: "tester" });
}

async function createSampleTarget(repoRoot) {
  const targetRoot = path.join(repoRoot, "sample/sample-app");
  await fs.mkdir(path.join(targetRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "tests"), { recursive: true });

  await fs.writeFile(
    path.join(targetRoot, "package.json"),
    JSON.stringify(
      {
        name: "sample-app",
        private: true,
        type: "module",
        scripts: {
          test: "node --test"
        }
      },
      null,
      2
    ) + "\n"
  );

  await fs.writeFile(
    path.join(targetRoot, "src/range.js"),
    [
      "function assertWholeNumber(value, name) {",
      "  if (!Number.isInteger(value)) {",
      "    throw new TypeError(`${name} must be an integer`);",
      "  }",
      "}",
      "",
      "export function normalizeRange(start, end) {",
      "  assertWholeNumber(start, 'start');",
      "  assertWholeNumber(end, 'end');",
      "  if (start > end) {",
      "    throw new RangeError('start must be less than or equal to end');",
      "  }",
      "  return { start, end };",
      "}",
      "",
      "export function listRange(start, end) {",
      "  const { start: min, end: max } = normalizeRange(start, end);",
      "  return Array.from({ length: max - min + 1 }, (_, index) => min + index);",
      "}",
      "",
      "export function sum(values) {",
      "  return values.reduce((total, value) => total + value, 0);",
      "}",
      ""
    ].join("\n")
  );

  await fs.writeFile(
    path.join(targetRoot, "src/index.js"),
    'export { listRange, normalizeRange, sum } from "./range.js";\n'
  );

  await fs.writeFile(
    path.join(targetRoot, "tests/range.test.js"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "",
      "import { listRange, sum } from '../src/index.js';",
      "",
      "test('range sums correctly', () => {",
      "  assert.equal(sum(listRange(1, 4)), 10);",
      "});",
      ""
    ].join("\n")
  );
}
