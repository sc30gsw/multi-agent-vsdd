import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { main as pathPhaseGate, _internal as gateInternal } from "../../scripts/hooks/mavsdd-path-phase-gate.js";
import {
  main as promoteAndSentinel,
  _internal as promoteInternal
} from "../../scripts/hooks/mavsdd-promote-and-sentinel.js";
import { main as loadActive } from "../../scripts/hooks/mavsdd-load-active.js";

async function makeTempRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-hooks-"));
  const real = fsSync.realpathSync.native(dir);
  await fs.mkdir(path.join(real, ".mavsdd"));
  return real;
}

test("path-phase-gate allows writes inside .mavsdd", async () => {
  const repoRoot = await makeTempRepo();
  try {
    await fs.mkdir(path.join(repoRoot, ".mavsdd/features/demo"), { recursive: true });
    const result = await pathPhaseGate({
      tool_name: "Write",
      tool_input: { file_path: path.join(repoRoot, ".mavsdd/features/demo/plan.md") },
      project_root: repoRoot
    });
    assert.equal(result.decision, "allow");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("path-phase-gate blocks writes outside .mavsdd without apply-lock", async () => {
  const repoRoot = await makeTempRepo();
  try {
    const result = await pathPhaseGate({
      tool_name: "Write",
      tool_input: { file_path: path.join(repoRoot, "src/secret.js") },
      project_root: repoRoot
    });
    assert.equal(result.decision, "block");
    assert.match(result.reason, /apply-lock/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("path-phase-gate honors a valid apply-lock with env token + PID", async () => {
  const repoRoot = await makeTempRepo();
  const originalToken = process.env.MAVSDD_APPLY_TOKEN;
  const originalPid = process.env.MAVSDD_APPLY_PARENT_PID;
  try {
    await fs.writeFile(
      path.join(repoRoot, ".mavsdd/.apply-lock"),
      JSON.stringify({ nonce: "abc123", pid: 4242 })
    );
    process.env.MAVSDD_APPLY_TOKEN = "abc123";
    process.env.MAVSDD_APPLY_PARENT_PID = "4242";
    const result = await pathPhaseGate({
      tool_name: "Write",
      tool_input: { file_path: path.join(repoRoot, "src/new.js") },
      project_root: repoRoot
    });
    assert.equal(result.decision, "allow");
  } finally {
    if (originalToken === undefined) delete process.env.MAVSDD_APPLY_TOKEN;
    else process.env.MAVSDD_APPLY_TOKEN = originalToken;
    if (originalPid === undefined) delete process.env.MAVSDD_APPLY_PARENT_PID;
    else process.env.MAVSDD_APPLY_PARENT_PID = originalPid;
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("path-phase-gate denies apply-lock file writes", async () => {
  const repoRoot = await makeTempRepo();
  try {
    const result = await pathPhaseGate({
      tool_name: "Write",
      tool_input: { file_path: path.join(repoRoot, ".mavsdd/.apply-lock") },
      project_root: repoRoot
    });
    assert.equal(result.decision, "block");
    assert.match(result.reason, /apply_lock_reserved/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("path-phase-gate blocks Bash commands that write outside .mavsdd", async () => {
  const repoRoot = await makeTempRepo();
  try {
    const result = await pathPhaseGate({
      tool_name: "Bash",
      tool_input: { command: `echo hi > ${path.join(repoRoot, "src/fail.js")}` },
      project_root: repoRoot
    });
    assert.equal(result.decision, "block");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("path-phase-gate rejects paths that traverse through a symlink", async () => {
  const repoRoot = await makeTempRepo();
  try {
    await fs.mkdir(path.join(repoRoot, ".mavsdd/features/demo"), { recursive: true });
    await fs.symlink("/etc/passwd", path.join(repoRoot, ".mavsdd/features/demo/leak"));
    const result = await pathPhaseGate({
      tool_name: "Write",
      tool_input: { file_path: path.join(repoRoot, ".mavsdd/features/demo/leak") },
      project_root: repoRoot
    });
    assert.equal(result.decision, "block");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("promote-and-sentinel renames a valid staged verdict and touches .ready when quorum is met", async () => {
  const repoRoot = await makeTempRepo();
  try {
    const iterationDir = path.join(
      repoRoot,
      ".mavsdd/features/demo/reviews/impl/iteration-1"
    );
    const inbox = path.join(iterationDir, "reviewer-1/.inbox");
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(
      path.join(iterationDir, "manifest.json"),
      JSON.stringify({ feature: "demo", scope: "impl", iteration: 1, reviewers: ["1"] })
    );
    const verdictPath = path.join(inbox, "verdict.json");
    await fs.writeFile(
      verdictPath,
      JSON.stringify({ verdict: "GREEN", findings: [] })
    );
    const result = await promoteAndSentinel({
      tool_name: "Write",
      tool_input: { file_path: verdictPath },
      project_root: repoRoot
    });
    assert.equal(result.decision, "allow");
    const canonical = path.join(iterationDir, "reviewer-1/verdict.json");
    const exists = await fs
      .stat(canonical)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, true);
    const ready = await fs
      .stat(path.join(iterationDir, ".ready"))
      .then(() => true)
      .catch(() => false);
    assert.equal(ready, true);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("promote-and-sentinel writes validation-errors.json for bad verdicts", async () => {
  const repoRoot = await makeTempRepo();
  try {
    const inbox = path.join(
      repoRoot,
      ".mavsdd/features/demo/reviews/impl/iteration-1/reviewer-1/.inbox"
    );
    await fs.mkdir(inbox, { recursive: true });
    const verdictPath = path.join(inbox, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify({ verdict: "PURPLE", findings: [] }));
    const result = await promoteAndSentinel({
      tool_name: "Write",
      tool_input: { file_path: verdictPath },
      project_root: repoRoot
    });
    assert.equal(result.decision, "allow");
    const errors = await fs.readFile(path.join(inbox, "validation-errors.json"), "utf8");
    assert.match(errors, /enum/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("load-active returns the active feature banner when one exists", async () => {
  const repoRoot = await makeTempRepo();
  try {
    await fs.writeFile(
      path.join(repoRoot, ".mavsdd/active.json"),
      JSON.stringify({ feature: "demo", updatedAt: "2026-04-22T00:00:00Z" })
    );
    const result = await loadActive({ project_root: repoRoot });
    assert.equal(result.decision, "allow");
    assert.match(result.systemMessage, /demo/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
