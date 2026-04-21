import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RosterError,
  loadRoles,
  normalizePrefix,
  validateTeamComposition,
  validateBriefPaths
} from "../../scripts/lib/roster.mjs";

test("normalizePrefix ensures trailing slash and collapses separators", () => {
  assert.equal(normalizePrefix("src/foo"), "src/foo/");
  assert.equal(normalizePrefix("src/foo/"), "src/foo/");
  assert.equal(normalizePrefix("src//foo"), "src/foo/");
});

test("loadRoles reads the default config/roles.json", async () => {
  const roles = await loadRoles();
  assert.ok(roles.roles);
  assert.ok(roles.roles.implementer);
  assert.ok(Array.isArray(roles.roles.implementer.allowedWritePaths));
});

test("validateTeamComposition accepts a well-formed team", async () => {
  const roles = await loadRoles();
  const team = {
    feature: "demo",
    units: [
      {
        id: "unit-a",
        role: "implementer",
        writePaths: ["src/foo/"],
        writeFiles: ["src/foo/constants.js"],
        dependsOn: []
      },
      {
        id: "unit-b",
        role: "test-engineer",
        writePaths: ["tests/foo/"],
        writeFiles: ["tests/foo/foo.test.js"],
        dependsOn: ["unit-a"]
      }
    ]
  };
  const validated = validateTeamComposition(team, roles);
  assert.equal(validated.maxParallel, 2);
});

test("validateTeamComposition rejects writePath outside role allowance", async () => {
  const roles = await loadRoles();
  assert.throws(
    () =>
      validateTeamComposition(
        {
          feature: "demo",
          units: [
            {
              id: "unit-a",
              role: "test-engineer",
              writePaths: ["src/core/"],
              dependsOn: []
            }
          ]
        },
        roles
      ),
    (error) => error instanceof RosterError && /allowed prefixes/.test(error.message)
  );
});

test("validateTeamComposition rejects writePaths that intersect between units", async () => {
  const roles = await loadRoles();
  assert.throws(
    () =>
      validateTeamComposition(
        {
          feature: "demo",
          units: [
            {
              id: "unit-a",
              role: "implementer",
              writePaths: ["src/foo/"],
              dependsOn: []
            },
            {
              id: "unit-b",
              role: "implementer",
              writePaths: ["src/foo/bar/"],
              dependsOn: []
            }
          ]
        },
        roles
      ),
    (error) => error instanceof RosterError && /overlap/.test(error.message)
  );
});

test("validateTeamComposition rejects writeFile duplicates across units", async () => {
  const roles = await loadRoles();
  assert.throws(
    () =>
      validateTeamComposition(
        {
          feature: "demo",
          units: [
            {
              id: "unit-a",
              role: "implementer",
              writeFiles: ["src/shared.js"],
              dependsOn: []
            },
            {
              id: "unit-b",
              role: "implementer",
              writeFiles: ["src/shared.js"],
              dependsOn: []
            }
          ]
        },
        roles
      ),
    (error) => error instanceof RosterError && /writeFile/.test(error.message)
  );
});

test("validateTeamComposition rejects absolute paths and traversal", async () => {
  const roles = await loadRoles();
  assert.throws(
    () =>
      validateTeamComposition(
        {
          feature: "demo",
          units: [
            { id: "bad-1", role: "implementer", writePaths: ["/etc/"], dependsOn: [] }
          ]
        },
        roles
      ),
    /absolute path not allowed/
  );
  assert.throws(
    () =>
      validateTeamComposition(
        {
          feature: "demo",
          units: [
            { id: "bad-2", role: "implementer", writePaths: ["src/../etc/"], dependsOn: [] }
          ]
        },
        roles
      ),
    /traversal/
  );
});

test("validateTeamComposition detects dependency cycles", async () => {
  const roles = await loadRoles();
  assert.throws(
    () =>
      validateTeamComposition(
        {
          feature: "demo",
          units: [
            { id: "a", role: "implementer", writePaths: ["src/a/"], dependsOn: ["b"] },
            { id: "b", role: "implementer", writePaths: ["src/b/"], dependsOn: ["a"] }
          ]
        },
        roles
      ),
    /cycle/
  );
});

test("validateTeamComposition clamps maxParallel to [1,5]", async () => {
  const roles = await loadRoles();
  const validated = validateTeamComposition(
    {
      feature: "demo",
      maxParallel: 9,
      units: [
        { id: "unit-a", role: "implementer", writePaths: ["src/a/"], dependsOn: [] }
      ]
    },
    roles
  );
  assert.equal(validated.maxParallel, 5);
});

test("validateBriefPaths rejects missing brief files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mavsdd-roster-"));
  try {
    await assert.rejects(
      validateBriefPaths(
        {
          units: [
            { id: "u1", briefPath: path.join(root, "contexts/unit-u1.md") }
          ]
        },
        root
      ),
      /briefPath not found/
    );
    await fs.mkdir(path.join(root, "contexts"), { recursive: true });
    await fs.writeFile(path.join(root, "contexts/unit-u1.md"), "brief\n");
    await validateBriefPaths(
      {
        units: [
          { id: "u1", briefPath: path.join(root, "contexts/unit-u1.md") }
        ]
      },
      root
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
