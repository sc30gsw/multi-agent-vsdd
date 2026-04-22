import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireLock,
  readLock,
  releaseLock,
  generateNonce,
  isLocked,
  verifyLock
} from "../../scripts/lib/apply-lock.mjs";

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-lock-"));
  const real = fsSync.realpathSync.native(dir);
  await fs.mkdir(path.join(real, ".mavsdd"));
  return real;
}

test("acquireLock creates a lock file and releaseLock removes it", async () => {
  const repoRoot = await makeRepo();
  try {
    assert.equal(await isLocked(repoRoot), false);
    const nonce = generateNonce();
    const body = await acquireLock(repoRoot, { feature: "demo", pid: 42, nonce });
    assert.equal(body.feature, "demo");
    assert.equal(body.pid, 42);
    assert.equal(body.nonce, nonce);
    assert.equal(await isLocked(repoRoot), true);
    const read = await readLock(repoRoot);
    assert.equal(read.nonce, nonce);
    await releaseLock(repoRoot);
    assert.equal(await isLocked(repoRoot), false);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("acquireLock refuses a second acquisition while held", async () => {
  const repoRoot = await makeRepo();
  try {
    await acquireLock(repoRoot, { feature: "demo", pid: 42, nonce: "n1" });
    await assert.rejects(
      acquireLock(repoRoot, { feature: "demo", pid: 43, nonce: "n2" }),
      /already held/
    );
    await releaseLock(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("acquireLock persists applyTxnId, baselineId, and status in the lock body", async () => {
  const repoRoot = await makeRepo();
  try {
    await acquireLock(repoRoot, {
      feature: "demo",
      pid: 11,
      nonce: "n1",
      applyTxnId: "apply-abc123",
      baselineId: "base-xyz",
      status: "running"
    });
    const body = await readLock(repoRoot);
    assert.equal(body.applyTxnId, "apply-abc123");
    assert.equal(body.baselineId, "base-xyz");
    assert.equal(body.status, "running");
  } finally {
    await releaseLock(repoRoot);
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("verifyLock validates token + parent pid", async () => {
  const repoRoot = await makeRepo();
  try {
    await acquireLock(repoRoot, { feature: "demo", pid: 42, nonce: "secret" });

    const ok = verifyLock(repoRoot, { token: "secret", parentPid: "42" });
    assert.equal(ok.ok, true);
    assert.equal(ok.body.feature, "demo");
    assert.equal(ok.body.pid, 42);

    const wrongToken = verifyLock(repoRoot, { token: "wrong", parentPid: "42" });
    assert.equal(wrongToken.ok, false);
    assert.equal(wrongToken.reason, "token_mismatch");

    const wrongPid = verifyLock(repoRoot, { token: "secret", parentPid: "99" });
    assert.equal(wrongPid.ok, false);
    assert.equal(wrongPid.reason, "pid_mismatch");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
