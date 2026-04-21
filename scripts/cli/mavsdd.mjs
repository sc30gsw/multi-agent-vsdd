#!/usr/bin/env node
import path from "node:path";

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
      print(state);
      return;
    }

    case "plan": {
      const feature = await resolveFeatureName(options, repoRoot);
      const state = await generatePlanArtifacts(repoRoot, feature, options);
      print({ feature, phase: state.phase });
      return;
    }

    case "plan-review": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runReview(repoRoot, feature, "plan", options);
      print(result);
      return;
    }

    case "aggregate": {
      const feature = await resolveFeatureName(options, repoRoot);
      if (!options.scope) {
        throw new Error("aggregate requires --scope plan|impl");
      }
      const result = await aggregateReviews(repoRoot, feature, options.scope);
      print(result);
      return;
    }

    case "approve-plan": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await recordApproval(repoRoot, feature, "plan", options);
      print(result);
      return;
    }

    case "red": {
      const feature = await resolveFeatureName(options, repoRoot);
      const state = await generateRedArtifacts(repoRoot, feature);
      print({ feature, phase: state.phase });
      return;
    }

    case "approve-orphan": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await approveOrphanCluster(repoRoot, feature, options);
      print(result);
      return;
    }

    case "implement": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runClaudeImplementation(repoRoot, feature);
      print(result);
      return;
    }

    case "stage": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await stageOperations(repoRoot, feature);
      print(result);
      return;
    }

    case "apply": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await applyOperations(repoRoot, feature);
      print(result);
      return;
    }

    case "verify": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runVerification(repoRoot, feature);
      print(result);
      return;
    }

    case "impl-review": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runReview(repoRoot, feature, "impl", options);
      print(result);
      return;
    }

    case "approve-impl": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await recordApproval(repoRoot, feature, "impl", options);
      print(result);
      return;
    }

    case "fix": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await runFixWorkflow(repoRoot, feature);
      print(result);
      return;
    }

    case "status": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await statusSummary(repoRoot, feature);
      print(result);
      return;
    }

    case "resume": {
      const feature = await resolveFeatureName(options, repoRoot);
      const result = await resumeSummary(repoRoot, feature);
      print(result);
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
