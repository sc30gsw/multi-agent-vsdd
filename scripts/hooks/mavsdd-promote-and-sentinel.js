// PostToolUse handler for mavsdd. Validates staged verdict.json files and
// atomically promotes them to the canonical location. Touches `.ready` when
// the review iteration reaches quorum.

import fs from "node:fs";
import path from "node:path";

import { detectBashWrites } from "../lib/bash-write-detector.mjs";
import { validate } from "../lib/schema.mjs";

function readJson(absolutePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function inferWritePaths(payload) {
  const toolName = payload?.tool_name || payload?.toolName;
  const toolInput = payload?.tool_input || payload?.toolInput || {};
  const paths = [];
  if ((toolName === "Write" || toolName === "Edit") && toolInput.file_path) {
    paths.push(toolInput.file_path);
  }
  if (toolName === "MultiEdit") {
    if (toolInput.file_path) paths.push(toolInput.file_path);
    if (Array.isArray(toolInput.edits)) {
      for (const edit of toolInput.edits) {
        if (edit?.file_path) paths.push(edit.file_path);
      }
    }
  }
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    for (const entry of detectBashWrites(toolInput.command)) {
      paths.push(entry.path);
    }
  }
  return paths;
}

function matchVerdictInbox(relativePath) {
  return /\.mavsdd[\\/]+features[\\/]+([^\\/]+)[\\/]+reviews[\\/]+(plan|impl)[\\/]+iteration-(\d+)[\\/]+reviewer-([^\\/]+)[\\/]+\.inbox[\\/]+verdict\.json$/.exec(
    relativePath
  );
}

async function promoteVerdict(repoRoot, relativePath) {
  const absolute = path.resolve(repoRoot, relativePath);
  const match = matchVerdictInbox(absolute);
  if (!match) return null;
  const payload = readJson(absolute);
  if (!payload) {
    return { relativePath, status: "empty" };
  }
  const result = await validate("mavsdd-verdict", payload);
  const reviewerDir = path.dirname(path.dirname(absolute));
  const iterationDir = path.dirname(reviewerDir);
  const errorsPath = path.join(path.dirname(absolute), "validation-errors.json");
  if (!result.valid) {
    fs.writeFileSync(errorsPath, `${JSON.stringify(result.errors, null, 2)}\n`);
    return { relativePath, status: "invalid", errors: result.errors };
  }
  if (fs.existsSync(errorsPath)) {
    fs.rmSync(errorsPath, { force: true });
  }
  const canonical = path.join(reviewerDir, "verdict.json");
  fs.renameSync(absolute, canonical);

  // Quorum check: touch .ready if every reviewer directory has a canonical verdict.json
  const manifestPath = path.join(iterationDir, "manifest.json");
  const manifest = readJson(manifestPath);
  if (manifest && Array.isArray(manifest.reviewers)) {
    const completed = manifest.reviewers.every((reviewerId) =>
      fs.existsSync(path.join(iterationDir, `reviewer-${reviewerId}`, "verdict.json"))
    );
    if (completed) {
      fs.writeFileSync(path.join(iterationDir, ".ready"), `ready\n`);
    }
  }
  return { relativePath, status: "promoted" };
}

export async function main(payload) {
  const repoRoot = payload?.project_root
    || payload?.projectRoot
    || process.env.CLAUDE_PROJECT_DIR
    || process.env.MAVSDD_PROJECT_DIR
    || process.cwd();
  if (!fs.existsSync(path.join(repoRoot, ".mavsdd"))) {
    return { decision: "allow", exitCode: 0 };
  }
  const writes = inferWritePaths(payload);
  const results = [];
  for (const inputPath of writes) {
    const relative = path.isAbsolute(inputPath)
      ? path.relative(repoRoot, inputPath)
      : inputPath;
    if (relative.startsWith("..")) continue;
    const result = await promoteVerdict(repoRoot, relative);
    if (result) results.push(result);
  }
  const hasInvalid = results.some((entry) => entry.status === "invalid");
  return {
    decision: "allow",
    exitCode: hasInvalid ? 0 : 0,
    detail: { promotions: results }
  };
}

export const _internal = { inferWritePaths, matchVerdictInbox, promoteVerdict };
