#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";

import {
  aggregateReviews,
  approveOrphanCluster,
  applyOperations,
  createFeatureState,
  generatePlanArtifacts,
  generateRedArtifacts,
  parseArgs,
  recordApproval,
  resolveFeatureName,
  resumeSummary,
  runClaudeImplementation,
  runFixWorkflow,
  runReview,
  runVerification,
  stageOperations,
  statusSummary
} from "../lib/mavsdd-core.mjs";

// plan §0: surface next-steps hints so users know which files to inspect and
// which command to run next. Every state-mutating CLI call runs through this
// helper before printing, so both Claude Code skills and terminal invocations
// get the same guidance.
async function buildNextSteps(repoRoot, feature, command) {
  if (!feature) return null;
  const featureRootDir = path.join(repoRoot, ".mavsdd", "features", feature);
  let state = null;
  try {
    state = JSON.parse(
      await fs.readFile(path.join(featureRootDir, "feature-state.json"), "utf8")
    );
  } catch {
    return null;
  }
  const phase = state.phase;
  const iter = state.reviewIterations || { plan: 0, impl: 0 };
  const planIter = iter.plan || 0;
  const implIter = iter.impl || 0;

  const inspectByPhase = {
    initialized: [
      `.mavsdd/features/${feature}/feature-state.json`,
      `.mavsdd/features/${feature}/config.json`
    ],
    planned: [
      `.mavsdd/features/${feature}/plan.md`,
      `.mavsdd/features/${feature}/team-composition.json`,
      `.mavsdd/features/${feature}/specs/requirements-index.json`,
      `.mavsdd/features/${feature}/specs/verification-architecture.md`,
      `.mavsdd/features/${feature}/specs/test-strategy.md`
    ],
    plan_reviewed: [
      `.mavsdd/features/${feature}/reviews/plan/iteration-${planIter}/aggregate.json`,
      `.mavsdd/features/${feature}/reviews/plan/iteration-${planIter}/reviewer-*/verdict.json`
    ],
    plan_approved: [`.mavsdd/features/${feature}/human-approvals.jsonl`],
    red: [
      `.mavsdd/features/${feature}/red/test-matrix.json`,
      `.mavsdd/features/${feature}/red/failing-tests.json`
    ],
    implemented: [
      `.mavsdd/features/${feature}/implementations/*/status.json`,
      `.mavsdd/features/${feature}/workspace/repo/**`
    ],
    staged: [`.mavsdd/features/${feature}/operations/*/operations.json`],
    applied: [`.mavsdd/features/${feature}/apply-log.jsonl`],
    verified: [
      `.mavsdd/features/${feature}/verification/summary.json`,
      `.mavsdd/features/${feature}/verification/reports/*.md`
    ],
    impl_reviewed: [
      `.mavsdd/features/${feature}/reviews/impl/iteration-${implIter}/aggregate.json`,
      `.mavsdd/features/${feature}/reviews/impl/iteration-${implIter}/reviewer-*/verdict.json`
    ],
    fix_required: [
      `.mavsdd/features/${feature}/fixes/orphan/*/cluster.json`,
      `.mavsdd/features/${feature}/fixes/orphan/*/resolution.json`
    ],
    done: [
      `.mavsdd/features/${feature}/feature-state.json`,
      `.mavsdd/features/${feature}/human-approvals.jsonl`
    ]
  };

  const nextByPhase = {
    initialized: `node scripts/cli/mavsdd.mjs plan --feature ${feature} --goal "<goal>"`,
    planned: `node scripts/cli/mavsdd.mjs plan-review --feature ${feature} --reviewers 1  # or inject mock verdicts and run aggregate`,
    plan_review_pending: `node scripts/cli/mavsdd.mjs aggregate --feature ${feature} --scope plan`,
    plan_reviewed: `node scripts/cli/mavsdd.mjs approve-plan --feature ${feature} --by <name> [--accept-risk "<reason>"]`,
    plan_approved: `node scripts/cli/mavsdd.mjs red --feature ${feature}`,
    red: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 node scripts/cli/mavsdd.mjs implement --feature ${feature}`,
    implemented: `node scripts/cli/mavsdd.mjs stage --feature ${feature}`,
    staged: `node scripts/cli/mavsdd.mjs apply --feature ${feature}`,
    applied: `node scripts/cli/mavsdd.mjs verify --feature ${feature}`,
    verified: `node scripts/cli/mavsdd.mjs impl-review --feature ${feature} --reviewers 1  # or mock`,
    impl_review_pending: `node scripts/cli/mavsdd.mjs aggregate --feature ${feature} --scope impl`,
    impl_reviewed: `node scripts/cli/mavsdd.mjs approve-impl --feature ${feature} --by <name> [--accept-risk "<reason>"]`,
    fix_required: `node scripts/cli/mavsdd.mjs fix --feature ${feature}`,
    blocked: `Review findings manually and either restart plan or open an orphan approval.`,
    done: `Feature complete. Inspect .mavsdd/features/${feature}/human-approvals.jsonl for the audit trail.`
  };

  const conditionalHint = (() => {
    const aggregate = state.lastAggregate || {};
    if (command === "approve-plan" && aggregate.plan === "RED") {
      return "aggregate.plan=RED — review findings in reviews/plan/iteration-*/aggregate.json before approving";
    }
    if (command === "approve-impl" && aggregate.impl === "RED") {
      return "aggregate.impl=RED — approve-impl is blocked until the impl aggregate is GREEN";
    }
    return null;
  })();

  return {
    phase,
    inspect: inspectByPhase[phase] || [],
    nextCommand: nextByPhase[phase] || "Run /mavsdd-status to see current state.",
    note: conditionalHint
  };
}

async function withNextSteps(repoRoot, feature, command, result) {
  const nextSteps = await buildNextSteps(repoRoot, feature, command);
  if (!nextSteps) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, nextSteps };
  }
  return { result, nextSteps };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const repoRoot = process.cwd();

  if (!command) {
    throw new Error("Usage: node scripts/cli/mavsdd.mjs <subcommand> [...options]");
  }

  switch (command) {
    case "init": {
      const feature = options.feature;
      if (!feature) {
        throw new Error("init requires --feature");
      }
      const state = await createFeatureState(repoRoot, feature, options);
      print(await withNextSteps(repoRoot, feature, command, state));
      return;
    }

    case "plan": {
      const feature = await resolveFeatureName(options, repoRoot);
      const state = await generatePlanArtifacts(repoRoot, feature, options);
      print(await withNextSteps(repoRoot, feature, command, { feature, phase: state.phase }));
      return;
    }

    case "plan-review": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runReview(repoRoot, feature, "plan", options);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "aggregate": {
      const feature = await resolveFeatureName(options, repoRoot);
      if (!options.scope) {
        throw new Error("aggregate requires --scope plan|impl");
      }
      const result = await aggregateReviews(repoRoot, feature, options.scope);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "approve-plan": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await recordApproval(repoRoot, feature, "plan", options);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "red": {
      const feature = await resolveFeatureName(options, repoRoot);
      const state = await generateRedArtifacts(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, { feature, phase: state.phase }));
      return;
    }

    case "approve-orphan": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await approveOrphanCluster(repoRoot, feature, options);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "implement": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runClaudeImplementation(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "stage": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await stageOperations(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "apply": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await applyOperations(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "verify": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runVerification(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "impl-review": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runReview(repoRoot, feature, "impl", options);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "approve-impl": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await recordApproval(repoRoot, feature, "impl", options);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "fix": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runFixWorkflow(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "status": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await statusSummary(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    case "resume": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await resumeSummary(repoRoot, feature);
      print(await withNextSteps(repoRoot, feature, command, result));
      return;
    }

    default:
      throw new Error(`Unknown subcommand: ${command}`);
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
