import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export class PathRejection extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "PathRejection";
    this.detail = detail;
  }
}

function normalizeInput(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathRejection("path input must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw new PathRejection("path contains NUL byte", { input });
  }
  return input;
}

function rejectIfAbsolute(input) {
  if (path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw new PathRejection("absolute paths are not allowed", { input });
  }
}

function rejectTraversal(input) {
  const segments = input.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    throw new PathRejection("path traversal (..) not allowed", { input });
  }
}

function ensureWithinRoot(target, repoAbs) {
  const suffix = repoAbs.endsWith(path.sep) ? repoAbs : repoAbs + path.sep;
  if (target !== repoAbs && !target.startsWith(suffix)) {
    throw new PathRejection(`path escapes root ${repoAbs}`, { target });
  }
}

function walkComponentsForSymlinks(repoAbs, absolutePath) {
  const suffix = repoAbs.endsWith(path.sep) ? repoAbs : repoAbs + path.sep;
  if (!absolutePath.startsWith(suffix) && absolutePath !== repoAbs) {
    throw new PathRejection(`path escapes root ${repoAbs}`, { target: absolutePath });
  }
  const relative = absolutePath === repoAbs ? "" : absolutePath.slice(suffix.length);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = repoAbs;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw new PathRejection(`symlink not allowed at ${current}`, { component: current });
      }
    } catch (error) {
      if (error instanceof PathRejection) throw error;
      if (error.code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
}

function resolveRealPath(absolutePath, repoAbs) {
  try {
    const real = fs.realpathSync.native(absolutePath);
    ensureWithinRoot(real, repoAbs);
    return real;
  } catch (error) {
    if (error.code === "ENOENT") {
      return absolutePath;
    }
    throw error;
  }
}

export function safeCanonical(inputPath, repoAbs, options = {}) {
  if (typeof repoAbs !== "string" || repoAbs.length === 0) {
    throw new PathRejection("repoAbs must be a non-empty absolute path", { repoAbs });
  }
  const normalizedRoot = fs.realpathSync.native(repoAbs);
  const input = normalizeInput(inputPath);
  rejectTraversal(input);
  if (options.allowAbsolute !== true) {
    rejectIfAbsolute(input);
  }
  const absolute = path.isAbsolute(input) ? input : path.resolve(normalizedRoot, input);
  ensureWithinRoot(absolute, normalizedRoot);
  walkComponentsForSymlinks(normalizedRoot, absolute);
  return resolveRealPath(absolute, normalizedRoot);
}

export async function safeCanonicalAsync(inputPath, repoAbs) {
  return Promise.resolve().then(() => safeCanonical(inputPath, repoAbs));
}

export function isPathWithin(target, root) {
  const rootSuffix = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(rootSuffix);
}

export function relativeWithinRoot(target, root) {
  if (!isPathWithin(target, root)) {
    throw new PathRejection(`path ${target} is not within ${root}`);
  }
  if (target === root) return "";
  const rootSuffix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.slice(rootSuffix.length);
}

export async function pathExists(absolutePath) {
  try {
    await fsPromises.lstat(absolutePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function hasTraversal(input) {
  try {
    rejectTraversal(input);
    return false;
  } catch (error) {
    if (error instanceof PathRejection) return true;
    throw error;
  }
}
