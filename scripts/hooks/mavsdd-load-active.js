// SessionStart handler for mavsdd. Reads .mavsdd/active.json and emits a small
// banner so subsequent commands know the active feature.

import fs from "node:fs";
import path from "node:path";

function readJson(absolutePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function main(payload) {
  const repoRoot = payload?.project_root
    || payload?.projectRoot
    || process.env.CLAUDE_PROJECT_DIR
    || process.env.MAVSDD_PROJECT_DIR
    || process.cwd();
  const activePath = path.join(repoRoot, ".mavsdd", "active.json");
  const active = readJson(activePath, null);
  if (!active) {
    return { decision: "allow", exitCode: 0 };
  }
  const banner = active.feature
    ? `mavsdd: active feature = ${active.feature}`
    : "mavsdd: no active feature";
  return {
    decision: "allow",
    exitCode: 0,
    systemMessage: banner
  };
}

export const _internal = {};
