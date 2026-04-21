import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "../..");
const DEFAULT_ROLES_PATH = path.join(PLUGIN_ROOT, "config/roles.json");

export class RosterError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "RosterError";
    this.detail = detail;
  }
}

export function normalizePrefix(prefix) {
  if (typeof prefix !== "string" || prefix.length === 0) return "";
  const cleaned = prefix.replace(/\\+/g, "/").replace(/\/+/g, "/");
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

export async function loadRoles(rolesPath = DEFAULT_ROLES_PATH) {
  const body = await fs.readFile(rolesPath, "utf8");
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || !parsed.roles) {
    throw new RosterError(`roles file malformed: ${rolesPath}`);
  }
  return parsed;
}

function ensureNoTraversal(inputPath, label) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new RosterError(`${label}: empty path`);
  }
  if (inputPath.includes("..")) {
    throw new RosterError(`${label}: traversal (..) not allowed`, { path: inputPath });
  }
  if (inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)) {
    throw new RosterError(`${label}: absolute path not allowed`, { path: inputPath });
  }
  if (inputPath.includes("**")) {
    throw new RosterError(`${label}: glob (**) not allowed`, { path: inputPath });
  }
}

function detectInterUnitCollisions(units, accessor, label) {
  const seen = new Map();
  for (const unit of units) {
    const values = accessor(unit) || [];
    for (const value of values) {
      if (seen.has(value)) {
        throw new RosterError(
          `${label} "${value}" claimed by multiple units: ${seen.get(value)} and ${unit.id}`
        );
      }
      seen.set(value, unit.id);
    }
  }
}

function detectWritePathPrefixIntersection(units) {
  const normalized = units.map((unit) => ({
    id: unit.id,
    paths: (unit.writePaths || []).map(normalizePrefix).filter(Boolean)
  }));
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const left = normalized[i];
      const right = normalized[j];
      for (const lp of left.paths) {
        for (const rp of right.paths) {
          if (lp.startsWith(rp) || rp.startsWith(lp)) {
            throw new RosterError(
              `writePaths overlap between ${left.id} (${lp}) and ${right.id} (${rp})`
            );
          }
        }
      }
    }
  }
}

function detectCycles(units) {
  const graph = new Map(units.map((unit) => [unit.id, unit.dependsOn || unit.depends_on || []]));
  const visiting = new Set();
  const visited = new Set();

  function walk(node, stack = []) {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw new RosterError(`dependency cycle detected: ${[...stack, node].join(" → ")}`);
    }
    visiting.add(node);
    const deps = graph.get(node) || [];
    for (const dep of deps) {
      if (!graph.has(dep)) {
        throw new RosterError(`unit ${node} depends on unknown unit ${dep}`);
      }
      walk(dep, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const unit of units) walk(unit.id);
}

function clampMaxParallel(team) {
  const raw = Number.isFinite(team.maxParallel) ? team.maxParallel : 2;
  return Math.max(1, Math.min(5, raw));
}

export function validateTeamComposition(team, roles) {
  if (!team || typeof team !== "object") {
    throw new RosterError("team-composition body is not an object");
  }
  if (!Array.isArray(team.units) || team.units.length === 0) {
    throw new RosterError("team-composition.units must contain at least one unit");
  }

  const rolesMap = roles.roles || {};
  for (const unit of team.units) {
    if (!unit.id) throw new RosterError("unit missing id");
    if (!unit.role) throw new RosterError(`unit ${unit.id} missing role`);
    const roleSpec = rolesMap[unit.role];
    if (!roleSpec) {
      throw new RosterError(`unit ${unit.id} references unknown role "${unit.role}"`);
    }
    const allowed = (roleSpec.allowedWritePaths || []).map(normalizePrefix);
    const writePaths = (unit.writePaths || []).map((value) => {
      ensureNoTraversal(value, `unit ${unit.id} writePath`);
      return normalizePrefix(value);
    });
    const writeFiles = unit.writeFiles || [];
    for (const file of writeFiles) {
      ensureNoTraversal(file, `unit ${unit.id} writeFile`);
    }
    for (const prefix of writePaths) {
      if (allowed.length > 0 && !allowed.some((allowedPrefix) => prefix.startsWith(allowedPrefix))) {
        throw new RosterError(
          `unit ${unit.id} writePath ${prefix} is not under role "${unit.role}" allowed prefixes: ${allowed.join(", ")}`
        );
      }
    }
    for (const file of writeFiles) {
      if (allowed.length > 0 && !allowed.some((allowedPrefix) => file.startsWith(allowedPrefix))) {
        throw new RosterError(
          `unit ${unit.id} writeFile ${file} is not under role "${unit.role}" allowed prefixes: ${allowed.join(", ")}`
        );
      }
    }
  }

  detectWritePathPrefixIntersection(team.units);
  detectInterUnitCollisions(team.units, (unit) => unit.writeFiles || [], "writeFile");
  detectCycles(team.units);

  const maxParallel = clampMaxParallel(team);
  return { ...team, maxParallel };
}

export async function validateTeamCompositionAgainstDefaultRoles(team) {
  const roles = await loadRoles();
  return validateTeamComposition(team, roles);
}

export async function validateBriefPaths(team, featureRootDir) {
  for (const unit of team.units) {
    if (!unit.briefPath) continue;
    const brief = path.isAbsolute(unit.briefPath)
      ? unit.briefPath
      : path.join(featureRootDir, unit.briefPath);
    try {
      await fs.access(brief);
    } catch {
      throw new RosterError(`unit ${unit.id} briefPath not found: ${brief}`);
    }
  }
}
