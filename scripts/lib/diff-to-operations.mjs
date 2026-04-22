import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const OP_ADD = "add";
export const OP_OVERWRITE = "overwrite";
export const OP_DELETE = "delete";
export const OP_RENAME = "rename";
export const OP_CHMOD = "chmod";

export const OP_KINDS = [OP_ADD, OP_OVERWRITE, OP_DELETE, OP_RENAME, OP_CHMOD];

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Plan §15.1: baseHash / contentHash are stored as `sha256:<hex>`.
function prefixHash(hex) {
  if (hex == null) return null;
  if (typeof hex === "string" && hex.startsWith("sha256:")) return hex;
  return `sha256:${hex}`;
}

// Plan §15.1: mode is recorded as a 3-digit octal string (e.g. "755").
export function modeToOctalString(mode) {
  if (mode == null) return null;
  if (typeof mode === "string") return mode;
  return (mode & 0o777).toString(8).padStart(3, "0");
}

export function parseHash(value) {
  if (!value) return null;
  if (typeof value !== "string") return null;
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

export function parseMode(value) {
  if (value == null) return null;
  if (typeof value === "number") return value & 0o777;
  if (typeof value === "string") {
    const parsed = parseInt(value, 8);
    return Number.isFinite(parsed) ? parsed & 0o777 : null;
  }
  return null;
}

export async function buildManifest(rootDir) {
  const manifest = {};
  await walk(rootDir, "", async (absolutePath, relativePath) => {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      return;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    manifest[relativePath] = {
      sha256: sha256Text(content),
      bytes: Buffer.byteLength(content),
      mode: stat.mode & 0o777
    };
  });
  return manifest;
}

async function walk(root, prefix, callback) {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      await walk(root, relativePath, callback);
      continue;
    }
    await callback(absolutePath, relativePath);
  }
}

export function classifyChange(before, after) {
  if (!before && !after) return null;
  if (!before) return OP_ADD;
  if (!after) return OP_DELETE;
  if (before.sha256 !== after.sha256) return OP_OVERWRITE;
  if (before.mode !== undefined && after.mode !== undefined && before.mode !== after.mode) {
    return OP_CHMOD;
  }
  return null;
}

function coerceKindFromOp(op) {
  if (op === OP_ADD) return "add";
  if (op === OP_OVERWRITE) return "modify";
  if (op === OP_DELETE) return "delete";
  if (op === OP_RENAME) return "rename";
  if (op === OP_CHMOD) return "chmod";
  return op;
}

export function buildRawChanges(baseManifest, repoManifest) {
  const allPaths = Array.from(new Set([...Object.keys(baseManifest), ...Object.keys(repoManifest)])).sort();
  const raw = [];
  for (const relativePath of allPaths) {
    const before = baseManifest[relativePath] || null;
    const after = repoManifest[relativePath] || null;
    const op = classifyChange(before, after);
    if (!op) continue;
    raw.push({
      op,
      path: relativePath,
      before,
      after
    });
  }
  return raw;
}

export function collapseRenames(rawChanges) {
  const deletes = rawChanges.filter((change) => change.op === OP_DELETE);
  const adds = rawChanges.filter((change) => change.op === OP_ADD);
  const consumedDeletes = new Set();
  const consumedAdds = new Set();
  const renames = [];

  for (const add of adds) {
    if (!add.after) continue;
    const matchIndex = deletes.findIndex((del) => {
      if (consumedDeletes.has(del.path)) return false;
      return del.before?.sha256 && del.before.sha256 === add.after.sha256;
    });
    if (matchIndex === -1) continue;
    const del = deletes[matchIndex];
    consumedDeletes.add(del.path);
    consumedAdds.add(add.path);
    renames.push({
      op: OP_RENAME,
      from: del.path,
      to: add.path,
      before: del.before,
      after: add.after
    });
  }

  const remaining = rawChanges.filter((change) => {
    if (change.op === OP_DELETE && consumedDeletes.has(change.path)) return false;
    if (change.op === OP_ADD && consumedAdds.has(change.path)) return false;
    return true;
  });

  return [...remaining, ...renames];
}

export async function materializeOperation(change, repoDir) {
  const base = {
    op: change.op,
    kind: coerceKindFromOp(change.op)
  };
  const beforeHash = prefixHash(change.before?.sha256);
  const afterHash = prefixHash(change.after?.sha256);
  if (change.op === OP_RENAME) {
    const newContent = await fs.readFile(path.join(repoDir, change.to), "utf8");
    return {
      ...base,
      from: change.from,
      to: change.to,
      path: change.to,
      baseHash: beforeHash,
      contentHash: afterHash,
      newHash: afterHash,
      newContent,
      mode: modeToOctalString(change.after?.mode)
    };
  }
  if (change.op === OP_DELETE) {
    return {
      ...base,
      path: change.path,
      baseHash: beforeHash,
      contentHash: null,
      newHash: null,
      newContent: null,
      mode: null
    };
  }
  if (change.op === OP_CHMOD) {
    return {
      ...base,
      path: change.path,
      baseHash: beforeHash,
      contentHash: afterHash,
      newHash: afterHash,
      newContent: null,
      mode: modeToOctalString(change.after?.mode),
      baseMode: modeToOctalString(change.before?.mode)
    };
  }
  const newContent = await fs.readFile(path.join(repoDir, change.path), "utf8");
  return {
    ...base,
    path: change.path,
    baseHash: beforeHash,
    contentHash: afterHash,
    newHash: afterHash,
    newContent,
    mode: modeToOctalString(change.after?.mode)
  };
}

export async function diffToOperations({ baseManifest, repoManifest, repoDir, detectRenames = true }) {
  const raw = buildRawChanges(baseManifest, repoManifest);
  const collapsed = detectRenames ? collapseRenames(raw) : raw;
  const operations = [];
  for (const change of collapsed) {
    const op = await materializeOperation(change, repoDir);
    operations.push(op);
  }
  return operations.sort((a, b) => {
    const keyA = a.path ?? a.to ?? "";
    const keyB = b.path ?? b.to ?? "";
    return keyA.localeCompare(keyB);
  });
}

export function operationTouchesPath(operation, relativePath) {
  if (operation.op === OP_RENAME) {
    return operation.from === relativePath || operation.to === relativePath;
  }
  return operation.path === relativePath;
}

export function operationPaths(operation) {
  if (operation.op === OP_RENAME) {
    return [operation.from, operation.to];
  }
  return [operation.path];
}

export function validateOperationAgainstBaseline(operation, baselineFiles) {
  const has = (path) => Boolean(baselineFiles && baselineFiles[path]);
  const op = operation.op
    ?? (operation.kind === "modify"
      ? OP_OVERWRITE
      : operation.kind === "add"
        ? OP_ADD
        : operation.kind === "delete"
          ? OP_DELETE
          : operation.kind);
  if (op === OP_ADD && has(operation.path)) {
    throw new Error(`operation "add" targets a path that already exists in baseline: ${operation.path}`);
  }
  if (op === OP_DELETE && !has(operation.path)) {
    throw new Error(`operation "delete" targets a path missing from baseline: ${operation.path}`);
  }
  if (op === OP_OVERWRITE && !has(operation.path)) {
    throw new Error(`operation "overwrite" targets a path missing from baseline: ${operation.path}`);
  }
  if (op === OP_RENAME && !has(operation.from)) {
    throw new Error(`operation "rename" source is missing from baseline: ${operation.from}`);
  }
  if (op === OP_RENAME && has(operation.to) && operation.from !== operation.to) {
    throw new Error(`operation "rename" destination already exists in baseline: ${operation.to}`);
  }
  if (op === OP_CHMOD && !has(operation.path)) {
    throw new Error(`operation "chmod" targets a path missing from baseline: ${operation.path}`);
  }
  return true;
}

export function validateOperationsAgainstBaseline(operations, baselineFiles) {
  for (const operation of operations) {
    validateOperationAgainstBaseline(operation, baselineFiles);
  }
  return true;
}
