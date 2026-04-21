#!/usr/bin/env node
// Privileged apply subprocess entry point.
// Reads .mavsdd/features/<feature>/operations/<unit>/operations.json manifests
// and applies them against state.targetRepo. The parent CLI is expected to
// hold the apply-lock and inject MAVSDD_APPLY_TOKEN / MAVSDD_APPLY_PARENT_PID.

import fs from "node:fs/promises";
import path from "node:path";

import { applyManifestList } from "../lib/apply-engine.mjs";
import { verifyLock, releaseLockSync } from "../lib/apply-lock.mjs";

async function readJson(absolutePath) {
  return JSON.parse(await fs.readFile(absolutePath, "utf8"));
}

async function main() {
  const repoRoot = process.env.MAVSDD_REPO_ROOT || process.cwd();
  const feature = process.env.MAVSDD_APPLY_FEATURE;
  const token = process.env.MAVSDD_APPLY_TOKEN;
  const parentPid = process.env.MAVSDD_APPLY_PARENT_PID;

  if (!feature) throw new Error("MAVSDD_APPLY_FEATURE is required");
  if (!token) throw new Error("MAVSDD_APPLY_TOKEN is required");
  if (!parentPid) throw new Error("MAVSDD_APPLY_PARENT_PID is required");

  const check = verifyLock(repoRoot, { token, parentPid });
  if (!check.ok) {
    throw new Error(`apply-lock verification failed: ${check.reason}`);
  }

  const featureRoot = path.join(repoRoot, ".mavsdd/features", feature);
  const state = await readJson(path.join(featureRoot, "feature-state.json"));
  const operationsDir = path.join(featureRoot, "operations");

  const unitDirs = await fs.readdir(operationsDir);
  const manifests = [];
  for (const unit of unitDirs) {
    const manifestPath = path.join(operationsDir, unit, "operations.json");
    manifests.push(await readJson(manifestPath));
  }

  const results = await applyManifestList(state.targetRepo, manifests);
  process.stdout.write(
    `${JSON.stringify({ feature, applied: results.length }, null, 2)}\n`
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    try {
      releaseLockSync(process.env.MAVSDD_REPO_ROOT || process.cwd());
    } catch {}
    process.exit(1);
  });
