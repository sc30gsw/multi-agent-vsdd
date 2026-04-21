import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PathRejection,
  safeCanonical,
  hasTraversal,
  isPathWithin,
  relativeWithinRoot
} from "../../scripts/lib/paths.mjs";

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-paths-"));
  return fsSync.realpathSync.native(dir);
}

test("safeCanonical accepts a normal file inside the root", async () => {
  const root = await makeRoot();
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "file.js"), "x\n");
    const canonical = safeCanonical("src/file.js", root);
    assert.equal(canonical, path.join(root, "src", "file.js"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeCanonical accepts a path whose leaf does not yet exist", async () => {
  const root = await makeRoot();
  try {
    await fs.mkdir(path.join(root, "src"));
    const canonical = safeCanonical("src/new-file.js", root);
    assert.equal(canonical, path.join(root, "src", "new-file.js"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeCanonical rejects parent-directory traversal", async () => {
  const root = await makeRoot();
  try {
    assert.throws(
      () => safeCanonical("../escape.js", root),
      (error) => error instanceof PathRejection && /traversal/.test(error.message)
    );
    assert.throws(
      () => safeCanonical("src/../../escape.js", root),
      (error) => error instanceof PathRejection && /traversal/.test(error.message)
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeCanonical rejects absolute paths outside the root", async () => {
  const root = await makeRoot();
  try {
    assert.throws(
      () => safeCanonical("/etc/passwd", root),
      (error) => error instanceof PathRejection && /escapes root/.test(error.message)
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeCanonical rejects a path that traverses through a symlink", async () => {
  const root = await makeRoot();
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.symlink("/etc/passwd", path.join(root, "src", "leak"));
    assert.throws(
      () => safeCanonical("src/leak", root),
      (error) => error instanceof PathRejection && /symlink/.test(error.message)
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeCanonical rejects a path whose ancestor directory is a symlink", async () => {
  const root = await makeRoot();
  try {
    await fs.mkdir(path.join(root, "real"));
    await fs.writeFile(path.join(root, "real/secret.txt"), "x\n");
    await fs.symlink(path.join(root, "real"), path.join(root, "via-link"));
    assert.throws(
      () => safeCanonical("via-link/secret.txt", root),
      (error) => error instanceof PathRejection && /symlink/.test(error.message)
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("hasTraversal and helpers expose detection primitives", async () => {
  assert.equal(hasTraversal("src/../../etc"), true);
  assert.equal(hasTraversal("src/../a"), true);
  assert.equal(hasTraversal("src/foo.js"), false);
  assert.equal(isPathWithin("/repo/src/a", "/repo"), true);
  assert.equal(isPathWithin("/repo2/src/a", "/repo"), false);
  assert.equal(relativeWithinRoot("/repo/src/a", "/repo"), path.join("src", "a"));
});
