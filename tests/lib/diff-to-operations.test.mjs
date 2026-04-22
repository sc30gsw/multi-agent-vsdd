import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  OP_ADD,
  OP_OVERWRITE,
  OP_DELETE,
  OP_RENAME,
  OP_CHMOD,
  buildManifest,
  buildRawChanges,
  classifyChange,
  collapseRenames,
  diffToOperations,
  validateOperationAgainstBaseline,
  validateOperationsAgainstBaseline
} from "../../scripts/lib/diff-to-operations.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-diff-"));
}

test("classifyChange detects add / overwrite / delete / chmod / noop", () => {
  assert.equal(classifyChange(null, { sha256: "x", mode: 0o644 }), OP_ADD);
  assert.equal(classifyChange({ sha256: "x", mode: 0o644 }, null), OP_DELETE);
  assert.equal(
    classifyChange({ sha256: "x", mode: 0o644 }, { sha256: "y", mode: 0o644 }),
    OP_OVERWRITE
  );
  assert.equal(
    classifyChange({ sha256: "x", mode: 0o644 }, { sha256: "x", mode: 0o755 }),
    OP_CHMOD
  );
  assert.equal(
    classifyChange({ sha256: "x", mode: 0o644 }, { sha256: "x", mode: 0o644 }),
    null
  );
});

test("collapseRenames converts paired delete+add with identical hash into a rename", () => {
  const rawChanges = [
    { op: OP_DELETE, path: "src/old.js", before: { sha256: "h1" }, after: null },
    { op: OP_ADD, path: "src/new.js", before: null, after: { sha256: "h1" } }
  ];
  const collapsed = collapseRenames(rawChanges);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].op, OP_RENAME);
  assert.equal(collapsed[0].from, "src/old.js");
  assert.equal(collapsed[0].to, "src/new.js");
});

test("collapseRenames keeps unrelated delete+add when hashes differ", () => {
  const rawChanges = [
    { op: OP_DELETE, path: "src/a.js", before: { sha256: "h1" }, after: null },
    { op: OP_ADD, path: "src/b.js", before: null, after: { sha256: "h2" } }
  ];
  const collapsed = collapseRenames(rawChanges);
  assert.equal(collapsed.length, 2);
});

test("buildRawChanges returns sorted tuples for all modified paths", () => {
  const base = { "a.js": { sha256: "x", mode: 0o644 }, "b.js": { sha256: "y", mode: 0o644 } };
  const repo = { "a.js": { sha256: "z", mode: 0o644 }, "c.js": { sha256: "q", mode: 0o644 } };
  const raw = buildRawChanges(base, repo);
  const ops = raw.map((change) => [change.op, change.path]).sort();
  assert.deepEqual(ops, [
    [OP_ADD, "c.js"],
    [OP_DELETE, "b.js"],
    [OP_OVERWRITE, "a.js"]
  ]);
});

test("diffToOperations materializes add / overwrite / delete / rename / chmod", async () => {
  const dir = await makeTempDir();
  try {
    const baseDir = path.join(dir, "base");
    const repoDir = path.join(dir, "repo");
    await fs.mkdir(path.join(baseDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });

    // add
    await fs.writeFile(path.join(repoDir, "src/new.js"), "new\n");
    // overwrite
    await fs.writeFile(path.join(baseDir, "src/over.js"), "old\n");
    await fs.writeFile(path.join(repoDir, "src/over.js"), "newer\n");
    // delete
    await fs.writeFile(path.join(baseDir, "src/gone.js"), "bye\n");
    // rename (same content across different paths)
    await fs.writeFile(path.join(baseDir, "src/old-name.js"), "rename-me\n");
    await fs.writeFile(path.join(repoDir, "src/new-name.js"), "rename-me\n");
    // chmod
    await fs.writeFile(path.join(baseDir, "src/exec.js"), "#!/usr/bin/env node\n");
    await fs.writeFile(path.join(repoDir, "src/exec.js"), "#!/usr/bin/env node\n");
    await fs.chmod(path.join(repoDir, "src/exec.js"), 0o755);

    const baseManifest = await buildManifest(baseDir);
    const repoManifest = await buildManifest(repoDir);

    const operations = await diffToOperations({ baseManifest, repoManifest, repoDir });
    const byKind = Object.fromEntries(
      operations.map((operation) => [
        operation.op === OP_RENAME ? `${operation.op}:${operation.to}` : `${operation.op}:${operation.path}`,
        operation
      ])
    );

    assert.ok(byKind[`${OP_ADD}:src/new.js`], "add missing");
    assert.equal(byKind[`${OP_ADD}:src/new.js`].kind, "add");
    assert.ok(byKind[`${OP_OVERWRITE}:src/over.js`], "overwrite missing");
    assert.equal(byKind[`${OP_OVERWRITE}:src/over.js`].kind, "modify");
    assert.ok(byKind[`${OP_DELETE}:src/gone.js`], "delete missing");
    assert.equal(byKind[`${OP_DELETE}:src/gone.js`].kind, "delete");

    const renameOperation = byKind[`${OP_RENAME}:src/new-name.js`];
    assert.ok(renameOperation, "rename missing");
    assert.equal(renameOperation.from, "src/old-name.js");
    assert.equal(renameOperation.to, "src/new-name.js");
    assert.equal(renameOperation.kind, "rename");

    const chmodOperation = byKind[`${OP_CHMOD}:src/exec.js`];
    assert.ok(chmodOperation, "chmod missing");
    // Plan §15.1: mode is recorded as an octal string.
    assert.equal(chmodOperation.mode, "755");
    assert.equal(chmodOperation.baseMode, "644");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("diffToOperations without rename detection leaves deletes and adds intact", async () => {
  const dir = await makeTempDir();
  try {
    const baseDir = path.join(dir, "base");
    const repoDir = path.join(dir, "repo");
    await fs.mkdir(path.join(baseDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "src/old.js"), "rename-me\n");
    await fs.writeFile(path.join(repoDir, "src/new.js"), "rename-me\n");

    const baseManifest = await buildManifest(baseDir);
    const repoManifest = await buildManifest(repoDir);

    const operations = await diffToOperations({
      baseManifest,
      repoManifest,
      repoDir,
      detectRenames: false
    });
    const ops = operations.map((operation) => operation.op).sort();
    assert.deepEqual(ops, [OP_ADD, OP_DELETE]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("validateOperationAgainstBaseline flags add-on-existing and delete-missing", () => {
  const baseline = { "src/existing.js": { sha256: "h" } };
  assert.throws(
    () => validateOperationAgainstBaseline({ op: OP_ADD, path: "src/existing.js" }, baseline),
    /already exists in baseline/
  );
  assert.throws(
    () => validateOperationAgainstBaseline({ op: OP_DELETE, path: "src/ghost.js" }, baseline),
    /missing from baseline/
  );
  assert.throws(
    () => validateOperationAgainstBaseline({ op: OP_OVERWRITE, path: "src/ghost.js" }, baseline),
    /missing from baseline/
  );
  validateOperationAgainstBaseline({ op: OP_ADD, path: "src/new.js" }, baseline);
});

test("validateOperationAgainstBaseline enforces rename source + destination invariants", () => {
  const baseline = { "src/old.js": { sha256: "h" }, "src/keep.js": { sha256: "k" } };
  assert.throws(
    () =>
      validateOperationAgainstBaseline(
        { op: OP_RENAME, from: "src/ghost.js", to: "src/new.js" },
        baseline
      ),
    /rename.*source/
  );
  assert.throws(
    () =>
      validateOperationAgainstBaseline(
        { op: OP_RENAME, from: "src/old.js", to: "src/keep.js" },
        baseline
      ),
    /rename.*destination/
  );
  validateOperationAgainstBaseline(
    { op: OP_RENAME, from: "src/old.js", to: "src/new.js" },
    baseline
  );
});

test("validateOperationsAgainstBaseline validates a whole list", () => {
  const baseline = { "a.js": { sha256: "h" } };
  validateOperationsAgainstBaseline([{ op: OP_ADD, path: "b.js" }], baseline);
  assert.throws(
    () => validateOperationsAgainstBaseline([{ op: OP_DELETE, path: "z.js" }], baseline),
    /missing from baseline/
  );
});

test("buildManifest skips symbolic links", async () => {
  const dir = await makeTempDir();
  try {
    await fs.writeFile(path.join(dir, "real.js"), "hi\n");
    await fs.symlink(path.join(dir, "real.js"), path.join(dir, "link.js"));
    const manifest = await buildManifest(dir);
    assert.ok(manifest["real.js"]);
    assert.equal(manifest["link.js"], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
