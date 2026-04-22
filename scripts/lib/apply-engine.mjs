import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  OP_ADD,
  OP_OVERWRITE,
  OP_DELETE,
  OP_RENAME,
  OP_CHMOD,
  parseHash,
  parseMode
} from "./diff-to-operations.mjs";

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function pathExists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hashFile(absolutePath) {
  if (!(await pathExists(absolutePath))) return null;
  const body = await fs.readFile(absolutePath, "utf8");
  return sha256Text(body);
}

async function ensureHashMatches(targetRepo, relativePath, expectedHash) {
  const live = path.join(targetRepo, relativePath);
  const current = await hashFile(live);
  const expected = parseHash(expectedHash);
  if (current !== (expected ?? null)) {
    throw new Error(
      `Base hash mismatch for ${relativePath}: expected ${expectedHash}, got ${current}`
    );
  }
}

function normalizeOp(operation) {
  if (operation.op) return operation.op;
  if (operation.kind === "modify") return OP_OVERWRITE;
  if (operation.kind === "add") return OP_ADD;
  if (operation.kind === "delete") return OP_DELETE;
  if (operation.kind === "rename") return OP_RENAME;
  if (operation.kind === "chmod") return OP_CHMOD;
  return operation.kind ?? OP_OVERWRITE;
}

export async function applyOperation(targetRepo, operation) {
  const op = normalizeOp(operation);

  if (op === OP_DELETE) {
    await ensureHashMatches(targetRepo, operation.path, operation.baseHash);
    const live = path.join(targetRepo, operation.path);
    if (await pathExists(live)) {
      await fs.rm(live);
    }
    return { op, path: operation.path };
  }

  if (op === OP_RENAME) {
    await ensureHashMatches(targetRepo, operation.from, operation.baseHash);
    const liveFrom = path.join(targetRepo, operation.from);
    const liveTo = path.join(targetRepo, operation.to);
    await fs.mkdir(path.dirname(liveTo), { recursive: true });
    if (operation.newContent && operation.newContent.length > 0) {
      await fs.writeFile(liveTo, operation.newContent);
      if (await pathExists(liveFrom)) {
        await fs.rm(liveFrom);
      }
    } else if (await pathExists(liveFrom)) {
      await fs.rename(liveFrom, liveTo);
    }
    const mode = parseMode(operation.mode);
    if (mode != null) {
      await fs.chmod(liveTo, mode);
    }
    return { op, from: operation.from, to: operation.to };
  }

  if (op === OP_CHMOD) {
    await ensureHashMatches(targetRepo, operation.path, operation.baseHash);
    const mode = parseMode(operation.mode);
    if (mode == null) {
      throw new Error(`chmod operation for ${operation.path} is missing mode`);
    }
    await fs.chmod(path.join(targetRepo, operation.path), mode);
    return { op, path: operation.path, mode };
  }

  // add / overwrite
  await ensureHashMatches(targetRepo, operation.path, operation.baseHash);
  const live = path.join(targetRepo, operation.path);
  await fs.mkdir(path.dirname(live), { recursive: true });
  await fs.writeFile(live, operation.newContent ?? "");
  const mode = parseMode(operation.mode);
  if (mode != null) {
    await fs.chmod(live, mode);
  }
  return { op, path: operation.path };
}

// Accept both plan-compliant `ops` and legacy `operations`; likewise for unit / unitId.
function extractOps(manifest) {
  if (!manifest) return [];
  if (Array.isArray(manifest.ops)) return manifest.ops;
  if (Array.isArray(manifest.operations)) return manifest.operations;
  return [];
}

export async function applyManifestList(targetRepo, manifests) {
  const applied = [];
  for (const manifest of manifests) {
    for (const operation of extractOps(manifest)) {
      const result = await applyOperation(targetRepo, operation);
      applied.push(result);
    }
  }
  return applied;
}
