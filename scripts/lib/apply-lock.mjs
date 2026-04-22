import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export const LOCK_RELATIVE_PATH = path.join(".mavsdd", ".apply-lock");

function lockPath(repoRoot) {
  return path.join(repoRoot, LOCK_RELATIVE_PATH);
}

export async function isLocked(repoRoot) {
  try {
    await fs.access(lockPath(repoRoot));
    return true;
  } catch {
    return false;
  }
}

export async function readLock(repoRoot) {
  try {
    const body = await fs.readFile(lockPath(repoRoot), "utf8");
    return JSON.parse(body);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function acquireLock(repoRoot, { feature, pid, nonce, applyTxnId, baselineId, status = "running" }) {
  const absolute = lockPath(repoRoot);
  const body = {
    feature,
    pid,
    nonce,
    applyTxnId: applyTxnId ?? null,
    baselineId: baselineId ?? null,
    status,
    startedAt: new Date().toISOString()
  };
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    const handle = await fs.open(absolute, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`apply-lock already held at ${absolute}`);
    }
    throw error;
  }
  return body;
}

export async function releaseLock(repoRoot) {
  try {
    await fs.rm(lockPath(repoRoot), { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function releaseLockSync(repoRoot) {
  try {
    fsSync.rmSync(lockPath(repoRoot), { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function generateNonce() {
  return crypto.randomBytes(32).toString("hex");
}

export function verifyLock(repoRoot, { token, parentPid }) {
  const body = fsSync.readFileSync(lockPath(repoRoot), "utf8");
  const parsed = JSON.parse(body);
  if (parsed.nonce && token !== parsed.nonce) {
    return { ok: false, reason: "token_mismatch" };
  }
  if (parsed.pid && parentPid !== undefined && String(parsed.pid) !== String(parentPid)) {
    return { ok: false, reason: "pid_mismatch" };
  }
  return { ok: true, body: parsed };
}
