import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  validateVerdictPayload,
  validateVerdictFile,
  writeValidationErrors
} from "../../scripts/lib/verdict-validator.mjs";

test("validateVerdictPayload returns no errors for a canonical verdict", async () => {
  const errors = await validateVerdictPayload(
    {
      verdict: "GREEN",
      scope: "impl",
      iteration: 2,
      reviewerId: "reviewer-1",
      findings: [{ id: "F-1", severity: "low", title: "tiny" }]
    },
    { scope: "impl", iteration: 2, reviewerId: "reviewer-1" }
  );
  assert.deepEqual(errors, []);
});

test("validateVerdictPayload flags schema enum mismatch", async () => {
  const errors = await validateVerdictPayload({ verdict: "PURPLE", findings: [] });
  assert.ok(errors.some((entry) => entry.kind === "schema"));
});

test("validateVerdictPayload detects reviewer / iteration / scope drift", async () => {
  const errors = await validateVerdictPayload(
    {
      verdict: "GREEN",
      findings: [],
      reviewerId: "reviewer-2",
      iteration: 3,
      scope: "plan"
    },
    { reviewerId: "reviewer-1", iteration: 2, scope: "impl" }
  );
  const kinds = errors.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ["iteration_mismatch", "reviewer_mismatch", "scope_mismatch"]);
});

test("validateVerdictPayload flags findings without an id", async () => {
  const errors = await validateVerdictPayload({
    verdict: "GREEN",
    findings: [{ severity: "low", title: "no id" }]
  });
  assert.ok(errors.some((entry) => entry.kind === "finding_missing_id"));
});

test("validateVerdictFile returns a parse_error for invalid JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-verdict-"));
  try {
    const target = path.join(dir, "broken.json");
    await fs.writeFile(target, "{not valid json");
    const errors = await validateVerdictFile(target);
    assert.ok(errors.some((entry) => entry.kind === "parse_error"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeValidationErrors writes a JSON file when errors exist and clears it when empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-verdict-write-"));
  try {
    await writeValidationErrors(dir, [{ kind: "schema", message: "broken" }]);
    const body = await fs.readFile(path.join(dir, "validation-errors.json"), "utf8");
    assert.match(body, /broken/);
    await writeValidationErrors(dir, []);
    const exists = await fs
      .stat(path.join(dir, "validation-errors.json"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
