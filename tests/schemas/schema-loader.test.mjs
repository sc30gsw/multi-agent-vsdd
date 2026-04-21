import test from "node:test";
import assert from "node:assert/strict";

import { validate } from "../../scripts/lib/schema.mjs";

test("state schema accepts a minimal valid state", async () => {
  const result = await validate("mavsdd-state", {
    feature: "sample",
    phase: "planned"
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("state schema rejects unknown phase", async () => {
  const result = await validate("mavsdd-state", {
    feature: "sample",
    phase: "flying"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /enum/.test(error.message)));
});

test("team-composition schema requires units with id/role", async () => {
  const missing = await validate("mavsdd-team-composition", {
    feature: "x",
    units: [{ id: "u1" }]
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((error) => /role/.test(error.message)));

  const ok = await validate("mavsdd-team-composition", {
    feature: "x",
    units: [
      {
        id: "u1",
        role: "implementer",
        writePaths: ["src/"],
        writeFiles: [],
        readPaths: ["src/"],
        readFiles: [],
        verificationTier: "tier0"
      }
    ]
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

test("operations schema validates add / overwrite / delete / rename / chmod", async () => {
  const manifest = {
    feature: "f",
    unitId: "u1",
    operations: [
      { op: "add", path: "src/a.js", contentHash: "h" },
      { op: "overwrite", path: "src/b.js", baseHash: "b", contentHash: "h" },
      { op: "delete", path: "src/c.js", baseHash: "b" },
      { op: "rename", from: "src/d.js", to: "src/e.js", baseHash: "b" },
      { op: "chmod", path: "src/f.js", baseHash: "b", mode: 493 }
    ]
  };
  const result = await validate("mavsdd-operations", manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const bad = await validate("mavsdd-operations", {
    feature: "f",
    unitId: "u1",
    operations: [{ op: "nope", path: "src/a.js" }]
  });
  assert.equal(bad.valid, false);
});

test("verdict schema accepts a minimal valid verdict", async () => {
  const result = await validate("mavsdd-verdict", {
    verdict: "GREEN",
    findings: []
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const bad = await validate("mavsdd-verdict", { verdict: "BLUE", findings: [] });
  assert.equal(bad.valid, false);
});

test("finding schema rejects findings without an id or severity", async () => {
  const bad = await validate("mavsdd-finding", { title: "missing id" });
  assert.equal(bad.valid, false);

  const ok = await validate("mavsdd-finding", {
    id: "FIND-1",
    severity: "high",
    title: "missing dep"
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});
