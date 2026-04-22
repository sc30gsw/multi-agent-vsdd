// PreToolUse gate for mavsdd. Fail-closed: any unexpected shape results in deny.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeCanonical, PathRejection, hasTraversal } from "../lib/paths.mjs";
import { detectBashWrites } from "../lib/bash-write-detector.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..", "..");

function readJson(absolutePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function projectRoot(payload) {
  return payload?.project_root
    || payload?.projectRoot
    || process.env.CLAUDE_PROJECT_DIR
    || process.env.MAVSDD_PROJECT_DIR
    || process.cwd();
}

function deriveWritePaths(payload) {
  const toolName = payload?.tool_name || payload?.toolName;
  const toolInput = payload?.tool_input || payload?.toolInput || {};
  const paths = [];
  if (toolName === "Write" || toolName === "Edit") {
    if (toolInput.file_path) paths.push(toolInput.file_path);
  }
  if (toolName === "MultiEdit") {
    if (toolInput.file_path) paths.push(toolInput.file_path);
    if (Array.isArray(toolInput.edits)) {
      for (const edit of toolInput.edits) {
        if (edit?.file_path) paths.push(edit.file_path);
      }
    }
  }
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    for (const entry of detectBashWrites(toolInput.command)) {
      paths.push(entry.path);
    }
  }
  return paths;
}

function inMavsddScope(relative) {
  return relative === ".mavsdd" || relative.startsWith(`.mavsdd${path.sep}`);
}

function inWorkspaceScope(relative) {
  return relative.includes(`${path.sep}workspace${path.sep}`);
}

function isVerdictInbox(relative) {
  return /\.mavsdd[\\/]+features[\\/]+[^\\/]+[\\/]+reviews[\\/]+(plan|impl)[\\/]+iteration-\d+[\\/]+reviewer-[^\\/]+[\\/]+\.inbox[\\/]+verdict\.json$/.test(relative);
}

function isApplyLock(relative) {
  return relative === `.mavsdd${path.sep}.apply-lock`;
}

function assertApplyAuthorization(repoRoot) {
  const lockPath = path.join(repoRoot, ".mavsdd", ".apply-lock");
  if (!fs.existsSync(lockPath)) {
    throw new Error("apply-lock missing");
  }
  const body = readJson(lockPath);
  if (!body) throw new Error("apply-lock unreadable");
  const tokenEnv = process.env.MAVSDD_APPLY_TOKEN;
  const pidEnv = process.env.MAVSDD_APPLY_PARENT_PID;
  if (body.nonce && tokenEnv !== body.nonce) {
    throw new Error("apply-lock token mismatch");
  }
  if (body.pid && pidEnv && String(body.pid) !== String(pidEnv)) {
    throw new Error("apply-lock PID mismatch");
  }
  return true;
}

function gateSinglePath(inputPath, repoRoot) {
  if (hasTraversal(inputPath)) {
    return { allowed: false, reason: "path_traversal", path: inputPath };
  }
  let canonical;
  try {
    canonical = safeCanonical(inputPath, repoRoot, { allowAbsolute: true });
  } catch (error) {
    if (error instanceof PathRejection) {
      return { allowed: false, reason: error.message, path: inputPath };
    }
    throw error;
  }
  const relative = path.relative(repoRoot, canonical);
  if (relative.startsWith("..")) {
    return { allowed: false, reason: "outside_repo", path: inputPath };
  }
  if (isApplyLock(relative)) {
    return { allowed: false, reason: "apply_lock_reserved", path: inputPath };
  }
  if (inMavsddScope(relative)) {
    if (isVerdictInbox(relative)) {
      return { allowed: true, reason: "inbox_verdict" };
    }
    if (inWorkspaceScope(relative)) {
      return { allowed: true, reason: "workspace_scope" };
    }
    return { allowed: true, reason: "mavsdd_scope" };
  }
  // Writes outside .mavsdd/ are only allowed when an apply subprocess owns the lock.
  try {
    assertApplyAuthorization(repoRoot);
  } catch (error) {
    return { allowed: false, reason: error.message, path: inputPath };
  }
  return { allowed: true, reason: "apply_authorized" };
}

export async function main(payload) {
  const repoRoot = projectRoot(payload);
  if (!fs.existsSync(path.join(repoRoot, ".mavsdd"))) {
    return { decision: "allow", exitCode: 0 };
  }
  const writes = deriveWritePaths(payload);
  if (writes.length === 0) {
    return { decision: "allow", exitCode: 0 };
  }
  const rejections = [];
  for (const inputPath of writes) {
    const verdict = gateSinglePath(inputPath, repoRoot);
    if (!verdict.allowed) rejections.push(verdict);
  }
  if (rejections.length > 0) {
    const reason = rejections.map((entry) => `${entry.path}: ${entry.reason}`).join("; ");
    return {
      decision: "block",
      reason,
      exitCode: 2
    };
  }
  return { decision: "allow", exitCode: 0 };
}

// Keep a module-level export for test harnesses.
export const _internal = {
  deriveWritePaths,
  gateSinglePath,
  projectRoot,
  PLUGIN_ROOT
};
