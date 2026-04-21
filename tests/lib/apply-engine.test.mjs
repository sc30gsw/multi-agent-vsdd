import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { applyOperation } from "../../scripts/lib/apply-engine.mjs";

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function makeTargetRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-apply-"));
  const real = fsSync.realpathSync.native(dir);
  return real;
}

test("applyOperation add creates a new file with expected content", async () => {
  const target = await makeTargetRepo();
  try {
    const operation = {
      op: "add",
      path: "src/created.js",
      baseHash: null,
      newContent: "hello\n"
    };
    await applyOperation(target, operation);
    const body = await fs.readFile(path.join(target, "src/created.js"), "utf8");
    assert.equal(body, "hello\n");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("applyOperation overwrite validates baseHash and writes the new content", async () => {
  const target = await makeTargetRepo();
  try {
    await fs.mkdir(path.join(target, "src"));
    await fs.writeFile(path.join(target, "src/existing.js"), "old\n");
    const operation = {
      op: "overwrite",
      path: "src/existing.js",
      baseHash: sha256Text("old\n"),
      newContent: "new\n"
    };
    await applyOperation(target, operation);
    assert.equal(await fs.readFile(path.join(target, "src/existing.js"), "utf8"), "new\n");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("applyOperation overwrite rolls back on baseHash mismatch", async () => {
  const target = await makeTargetRepo();
  try {
    await fs.mkdir(path.join(target, "src"));
    await fs.writeFile(path.join(target, "src/existing.js"), "mutated\n");
    const operation = {
      op: "overwrite",
      path: "src/existing.js",
      baseHash: sha256Text("original\n"),
      newContent: "new\n"
    };
    await assert.rejects(
      applyOperation(target, operation),
      /Base hash mismatch/
    );
    assert.equal(await fs.readFile(path.join(target, "src/existing.js"), "utf8"), "mutated\n");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("applyOperation delete removes a matching file", async () => {
  const target = await makeTargetRepo();
  try {
    await fs.mkdir(path.join(target, "src"));
    await fs.writeFile(path.join(target, "src/to-delete.js"), "bye\n");
    await applyOperation(target, {
      op: "delete",
      path: "src/to-delete.js",
      baseHash: sha256Text("bye\n")
    });
    assert.equal(fsSync.existsSync(path.join(target, "src/to-delete.js")), false);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("applyOperation rename moves a file when content is unchanged", async () => {
  const target = await makeTargetRepo();
  try {
    await fs.mkdir(path.join(target, "src"));
    await fs.writeFile(path.join(target, "src/old.js"), "body\n");
    await applyOperation(target, {
      op: "rename",
      from: "src/old.js",
      to: "src/new.js",
      baseHash: sha256Text("body\n")
    });
    assert.equal(fsSync.existsSync(path.join(target, "src/old.js")), false);
    assert.equal(await fs.readFile(path.join(target, "src/new.js"), "utf8"), "body\n");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("applyOperation chmod updates permissions bits", async () => {
  const target = await makeTargetRepo();
  try {
    await fs.mkdir(path.join(target, "bin"));
    await fs.writeFile(path.join(target, "bin/run"), "#!/bin/sh\n");
    await fs.chmod(path.join(target, "bin/run"), 0o644);
    await applyOperation(target, {
      op: "chmod",
      path: "bin/run",
      baseHash: sha256Text("#!/bin/sh\n"),
      mode: 0o755
    });
    const stat = await fs.stat(path.join(target, "bin/run"));
    assert.equal(stat.mode & 0o777, 0o755);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});
