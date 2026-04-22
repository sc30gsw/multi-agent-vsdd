import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  OP_ADD,
  OP_OVERWRITE,
  OP_DELETE,
  OP_RENAME,
  OP_CHMOD,
  buildManifest as buildDiffManifest,
  diffToOperations,
  operationPaths,
  validateOperationsAgainstBaseline
} from "./diff-to-operations.mjs";
import { assertValid } from "./schema.mjs";
import {
  acquireLock,
  releaseLock,
  generateNonce,
  isLocked,
  readLock
} from "./apply-lock.mjs";
import { aggregateVerdicts as aggregateVerdictsCore } from "./aggregate.mjs";

export const PHASES = [
  "initialized",
  "planned",
  "plan_review_pending",
  "plan_reviewed",
  "plan_review_inconclusive",
  "plan_approved",
  "red",
  "implementing",
  "implemented",
  "ready_to_stage",
  "staged",
  "impl_applying",
  "applied",
  "verifying",
  "verified",
  "impl_review_pending",
  "impl_reviewed",
  "impl_review_inconclusive",
  "fix_required",
  "blocked",
  "done"
];

// Directed transition table. Keys are source phases, values are the set of
// phases the feature may move into next. `*` means "no restriction" (used for
// administrative / resume paths).
export const PHASE_TRANSITIONS = {
  initialized: ["planned"],
  planned: ["plan_review_pending", "plan_reviewed", "plan_approved"],
  plan_review_pending: ["plan_reviewed", "plan_review_inconclusive"],
  plan_reviewed: ["plan_approved", "planned"],
  plan_review_inconclusive: ["plan_approved", "planned"],
  plan_approved: ["red"],
  red: ["implementing", "implemented"],
  implementing: ["implemented"],
  implemented: ["ready_to_stage", "staged"],
  ready_to_stage: ["staged"],
  staged: ["impl_applying", "applied"],
  impl_applying: ["applied"],
  applied: ["verifying", "verified"],
  verifying: ["verified"],
  verified: ["impl_review_pending", "impl_reviewed"],
  impl_review_pending: ["impl_reviewed", "impl_review_inconclusive"],
  impl_reviewed: ["done", "fix_required"],
  impl_review_inconclusive: ["done", "fix_required"],
  fix_required: ["implementing", "blocked"],
  blocked: ["implementing", "fix_required"],
  done: []
};

export function isTransitionAllowed(fromPhase, toPhase) {
  if (fromPhase === toPhase) return true;
  if (!PHASES.includes(fromPhase) || !PHASES.includes(toPhase)) return false;
  const allowed = PHASE_TRANSITIONS[fromPhase] || [];
  return allowed.includes(toPhase);
}

export function assertTransition(fromPhase, toPhase) {
  if (!isTransitionAllowed(fromPhase, toPhase)) {
    throw new Error(`illegal phase transition ${fromPhase} → ${toPhase}`);
  }
}

export function transitionPhase(state, toPhase) {
  assertTransition(state.phase, toPhase);
  state.phase = toPhase;
  return state;
}

export const TERMINAL_PHASES = new Set(["done", "blocked"]);

export function ensureCommandEntryPhase(state, command, allowedPhases) {
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new Error(
      `${command} is not permitted from terminal phase "${state.phase}"; use resume or start a new feature`
    );
  }
  if (Array.isArray(allowedPhases) && allowedPhases.length > 0 && !allowedPhases.includes(state.phase)) {
    throw new Error(
      `${command} requires one of [${allowedPhases.join(", ")}], but feature is in phase "${state.phase}"`
    );
  }
}

const PLAN_ARTIFACTS = [
  "plan.md",
  "specs/behavioral-spec.md",
  "specs/requirements-index.json",
  "specs/verification-architecture.md",
  "specs/test-strategy.md",
  "specs/convergence-checklist.md",
  "team-composition.json",
  "contexts/planner-brief.md",
  "contexts/repo-pointers.md",
  "contexts/codex-rubric-plan.md"
];

const IMPL_ARTIFACTS = [
  "operations",
  "verification/summary.json",
  "verification/profile.json",
  "implementations",
  "contexts/codex-rubric-impl.md"
];

const EMPTY_JSON_FILES = {
  "team-runtime/reviewer-jobs.json": [],
  "traceability/coverage-matrix.json": {
    generatedAt: null,
    requirements: []
  },
  "workspace/baseline-manifest.json": {
    generatedAt: null,
    files: {}
  }
};

const TIER_ORDER = ["tier0", "tier1", "tier2", "tier3"];

export function parseArgs(argv) {
  const options = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }

    const stripped = token.slice(2);
    const equalsIndex = stripped.indexOf("=");

    if (equalsIndex >= 0) {
      const key = stripped.slice(0, equalsIndex);
      options[key] = stripped.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[stripped] = true;
      continue;
    }

    options[stripped] = next;
    index += 1;
  }

  return options;
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function readJson(targetPath, fallback = null) {
  if (!(await pathExists(targetPath))) {
    return fallback;
  }

  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(`${targetPath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(`${targetPath}.tmp`, targetPath);
}

export async function writeText(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, value);
}

export async function appendJsonl(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.appendFile(targetPath, `${JSON.stringify(value)}\n`);
}

export function repoMavsddRoot(repoRoot) {
  return path.join(repoRoot, ".mavsdd");
}

export function featureRoot(repoRoot, feature) {
  return path.join(repoMavsddRoot(repoRoot), "features", feature);
}

export function activeStatePath(repoRoot) {
  return path.join(repoMavsddRoot(repoRoot), "active.json");
}

export function statePath(repoRoot, feature) {
  return path.join(featureRoot(repoRoot, feature), "feature-state.json");
}

export function reviewerJobsPath(repoRoot, feature) {
  return path.join(featureRoot(repoRoot, feature), "team-runtime", "reviewer-jobs.json");
}

export function runMetadataPath(repoRoot, feature) {
  return path.join(featureRoot(repoRoot, feature), "run-metadata", "events.jsonl");
}

export function nowIso() {
  return new Date().toISOString();
}

export function buildId(prefix, seed = nowIso()) {
  return `${prefix}-${sha256Text(seed).slice(0, 12)}`;
}

export function hashObject(value) {
  return sha256Text(JSON.stringify(value));
}

export function resolveFeatureName(options, repoRoot) {
  if (options.feature) {
    return slugify(options.feature);
  }

  return readJson(activeStatePath(repoRoot)).then((active) => {
    if (!active?.currentFeature) {
      throw new Error("No active feature. Use --feature or run init first.");
    }
    return active.currentFeature;
  });
}

export async function detectExternalStatus(repoRoot) {
  return {
    gh: detectGitHubStatus(repoRoot),
    claude: detectClaudeStatus(repoRoot),
    codex: detectCodexStatus(repoRoot)
  };
}

function detectGitHubStatus(repoRoot) {
  const result = runProcess("gh", ["auth", "status"], { cwd: repoRoot });
  if (result.status === 0) {
    return {
      ok: true,
      status: "logged_in",
      detail: result.stdout.trim() || "logged in"
    };
  }

  if (result.stdout.includes("invalid") || result.stderr.includes("invalid")) {
    return {
      ok: false,
      status: "invalid",
      detail: `${result.stdout}\n${result.stderr}`.trim()
    };
  }

  return {
    ok: false,
    status: "unavailable",
    detail: `${result.stdout}\n${result.stderr}`.trim()
  };
}

function detectClaudeStatus(repoRoot) {
  const result = runProcess("claude", ["auth", "status"], { cwd: repoRoot });

  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return {
      ok: Boolean(parsed.loggedIn),
      status: parsed.loggedIn ? "logged_in" : "logged_out",
      detail: result.stdout.trim()
    };
  } catch {
    return {
      ok: false,
      status: "unavailable",
      detail: `${result.stdout}\n${result.stderr}`.trim()
    };
  }
}

function detectCodexStatus(repoRoot) {
  const result = runProcess("codex", ["login", "status"], { cwd: repoRoot });
  const joined = `${result.stdout}\n${result.stderr}`.trim();

  return {
    ok: result.status === 0 && /Logged in/i.test(joined),
    status: result.status === 0 && /Logged in/i.test(joined) ? "logged_in" : "logged_out",
    detail: joined
  };
}

export function ensureAgentTeamsPreflight(repoRoot) {
  const claudeVersion = runProcess("claude", ["--version"], { cwd: repoRoot });
  const versionMatch = `${claudeVersion.stdout} ${claudeVersion.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);

  if (!versionMatch) {
    throw new Error("Failed to read Claude Code version.");
  }

  const [major, minor, patch] = versionMatch.slice(1).map(Number);
  const enoughVersion =
    major > 2 ||
    (major === 2 && minor > 1) ||
    (major === 2 && minor === 1 && patch >= 32);

  if (!enoughVersion) {
    throw new Error("Claude Code v2.1.32+ is required for Agent Teams.");
  }

  if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
    throw new Error("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 is required.");
  }
}

export function ensureCodexPreflight(repoRoot) {
  const status = detectCodexStatus(repoRoot);
  if (!status.ok) {
    throw new Error(`Codex CLI is not ready: ${status.detail}`);
  }
}

export function ensureClaudePreflight(repoRoot) {
  const status = detectClaudeStatus(repoRoot);
  if (!status.ok) {
    throw new Error(`Claude CLI is not ready: ${status.detail}`);
  }
}

export async function ensureFeatureScaffold(repoRoot, feature) {
  const root = featureRoot(repoRoot, feature);
  const directories = [
    "contexts",
    "fixes/orphan",
    "implementations",
    "operations",
    "red",
    "reviews/plan",
    "reviews/impl",
    "specs",
    "team-runtime",
    "traceability",
    "run-metadata",
    "verification/reports",
    "workspace/base",
    "workspace/repo",
    "workspace/runtime"
  ];

  await ensureDir(root);
  for (const directory of directories) {
    await ensureDir(path.join(root, directory));
  }

  for (const [relativePath, value] of Object.entries(EMPTY_JSON_FILES)) {
    const absolutePath = path.join(root, relativePath);
    if (!(await pathExists(absolutePath))) {
      await writeJson(absolutePath, value);
    }
  }
}

export async function createFeatureState(repoRoot, feature, options = {}) {
  const targetRepo = options.target
    ? path.resolve(repoRoot, options.target)
    : path.resolve(repoRoot, "sample/sample-app");

  const title = options.title || `Deliver ${feature}`;
  const goal =
    options.goal ||
    "Add sumRange(start, end) and describeRange(start, end) to the sample app with node:test coverage.";
  const unitName = options.unit || "sample-unit";
  const verifyCommand = options["verify-command"] || "npm test";
  const external = await detectExternalStatus(repoRoot);
  const timestamp = nowIso();

  const state = {
    feature,
    title,
    goal,
    unitName,
    targetRepo,
    targetRepoRelative: path.relative(repoRoot, targetRepo) || ".",
    verifyCommand,
    createdAt: timestamp,
    updatedAt: timestamp,
    phase: "initialized",
    approvals: {
      plan: false,
      implementation: false
    },
    reviewIterations: {
      plan: 0,
      impl: 0
    },
    lastAggregate: {
      plan: null,
      impl: null
    },
    external
  };

  await ensureFeatureScaffold(repoRoot, feature);
  await writeJson(statePath(repoRoot, feature), state);
  await writeJson(activeStatePath(repoRoot), {
    currentFeature: feature,
    updatedAt: timestamp
  });
  await initializeFeatureFiles(repoRoot, feature, state);
  await appendRunMetadata(repoRoot, feature, {
    command: "init",
    kind: "orchestration",
    status: "completed",
    detail: {
      feature,
      targetRepo: state.targetRepoRelative,
      verifyCommand
    }
  });
  return state;
}

async function initializeFeatureFiles(repoRoot, feature, state) {
  const root = featureRoot(repoRoot, feature);

  await writeText(
    path.join(root, "contexts/codex-rubric-plan.md"),
    [
      "# Codex Rubric: Plan",
      "",
      "- Requirements are explicit and testable.",
      "- Team composition matches the required file surface.",
      "- Verification plan can prove the feature works.",
      "- Human approval gate is preserved."
    ].join("\n")
  );

  await writeText(
    path.join(root, "contexts/codex-rubric-impl.md"),
    [
      "# Codex Rubric: Implementation",
      "",
      "- All requested source files are implemented.",
      "- Tests prove the new behavior.",
      "- No unrelated regressions are introduced.",
      "- Verification evidence matches the requested goal."
    ].join("\n")
  );

  await writeJson(path.join(root, "team-runtime/team-state.json"), {
    feature,
    status: "idle",
    executor: null,
    units: [],
    updatedAt: state.updatedAt
  });

  await appendJsonl(path.join(root, "team-runtime/task-ledger.jsonl"), {
    ts: state.updatedAt,
    phase: "initialized",
    event: "feature_initialized",
    feature
  });

  await appendJsonl(path.join(root, "traceability/contract-chain.jsonl"), {
    ts: state.updatedAt,
    type: "feature_initialized",
    feature,
    goal: state.goal
  });
}

export async function loadState(repoRoot, feature) {
  const state = await readJson(statePath(repoRoot, feature));
  if (!state) {
    throw new Error(`Feature not found: ${feature}`);
  }
  return state;
}

export async function saveState(repoRoot, feature, state) {
  state.updatedAt = nowIso();
  await assertValid("mavsdd-state", state, `feature-state/${feature}`);
  await writeJson(statePath(repoRoot, feature), state);
}

export async function appendRunMetadata(repoRoot, feature, event) {
  await appendJsonl(runMetadataPath(repoRoot, feature), {
    eventId: buildId("run", `${feature}:${event.command}:${nowIso()}`),
    createdAt: nowIso(),
    ...event
  });
}

async function appendTraceability(repoRoot, feature, entry) {
  await appendJsonl(path.join(featureRoot(repoRoot, feature), "traceability/contract-chain.jsonl"), {
    ts: nowIso(),
    ...entry
  });
}

function buildFeatureConfig(state) {
  return {
    schemaVersion: "1.0",
    juryCount: 1,
    juryTimeoutSec: 900,
    maxFixIterations: 3,
    maxReviewerRetries: 2,
    maxFeatureTokenBudget: 4_000_000,
    maxReviewTokenBudget: 1_200_000,
    artifactRetentionDays: 30,
    workspaceGcDays: 7,
    verificationProfileRef: `.mavsdd/features/${state.feature}/verification/profile.json`,
    reviewPolicy: {
      mode: "fail-closed-adversarial-gate",
      quorumRatio: "1/1"
    },
    modelPolicy: {
      planner: {
        provider: "anthropic",
        requestedModel: "opus",
        requestedEffort: "xhigh"
      },
      reviewer: {
        provider: "openai-responses",
        requestedModel: "gpt-5.4",
        requestedEffort: "high"
      },
      implementer: {
        provider: "anthropic",
        requestedModel: "sonnet",
        requestedEffort: "high"
      },
      fixer: {
        provider: "anthropic",
        requestedModel: "sonnet",
        requestedEffort: "high"
      }
    }
  };
}

function buildVerificationProfile(state) {
  return {
    schemaVersion: "1.0",
    language: "javascript",
    tierCommands: {
      tier0: [state.verifyCommand],
      tier1: [],
      tier2: [],
      tier3: []
    },
    waiverPolicy: {
      requiresApproval: true,
      unsupportedTierBehavior: "fail_closed"
    }
  };
}

function normalizeVerificationProfile(profile, state) {
  const fallback = buildVerificationProfile(state);
  const tierCommands = profile?.tierCommands && typeof profile.tierCommands === "object"
    ? {
        tier0: Array.isArray(profile.tierCommands.tier0) ? profile.tierCommands.tier0 : fallback.tierCommands.tier0,
        tier1: Array.isArray(profile.tierCommands.tier1) ? profile.tierCommands.tier1 : fallback.tierCommands.tier1,
        tier2: Array.isArray(profile.tierCommands.tier2) ? profile.tierCommands.tier2 : fallback.tierCommands.tier2,
        tier3: Array.isArray(profile.tierCommands.tier3) ? profile.tierCommands.tier3 : fallback.tierCommands.tier3
      }
    : fallback.tierCommands;

  return {
    schemaVersion: profile?.schemaVersion || fallback.schemaVersion,
    language: profile?.language || fallback.language,
    tierCommands,
    waiverPolicy: profile?.waiverPolicy || fallback.waiverPolicy
  };
}

function normalizeScopePrefix(value) {
  if (!value) {
    return null;
  }

  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

function pathAllowedByUnit(relativePath, unit) {
  const writeFiles = Array.isArray(unit.writeFiles) ? unit.writeFiles : [];
  if (writeFiles.includes(relativePath)) {
    return true;
  }

  const writePaths = (Array.isArray(unit.writePaths) ? unit.writePaths : [])
    .map(normalizeScopePrefix)
    .filter(Boolean);
  return writePaths.some((prefix) => relativePath.startsWith(prefix));
}

function findOwningUnits(units, relativePath) {
  return units.filter((unit) => pathAllowedByUnit(relativePath, unit));
}

function inferPathsFromFiles(files) {
  return Array.from(
    new Set(
      files
        .map((file) => path.dirname(file))
        .filter((directory) => directory && directory !== ".")
        .map(normalizeScopePrefix)
    )
  );
}

function normalizeUnitDefinition(unit) {
  const files = Array.isArray(unit.paths) && unit.paths.length > 0
    ? unit.paths
    : Array.isArray(unit.writeFiles)
      ? unit.writeFiles
      : [];
  const writeFiles = Array.isArray(unit.writeFiles) && unit.writeFiles.length > 0
    ? unit.writeFiles
    : files;
  const writePaths = Array.isArray(unit.writePaths) && unit.writePaths.length > 0
    ? unit.writePaths.map(normalizeScopePrefix)
    : inferPathsFromFiles(writeFiles);
  const readFiles = Array.isArray(unit.readFiles) && unit.readFiles.length > 0
    ? unit.readFiles
    : writeFiles;
  const readPaths = Array.isArray(unit.readPaths) && unit.readPaths.length > 0
    ? unit.readPaths.map(normalizeScopePrefix)
    : inferPathsFromFiles(readFiles);

  return {
    ...unit,
    paths: files,
    dependsOn: Array.isArray(unit.dependsOn) ? unit.dependsOn : [],
    writeFiles,
    writePaths,
    readFiles,
    readPaths,
    verificationTier: unit.verificationTier || "tier0",
    briefPath: unit.briefPath || `contexts/unit-${unit.id}.md`
  };
}

function normalizeTeamComposition(team) {
  return {
    ...team,
    units: team.units.map((unit) => normalizeUnitDefinition(unit))
  };
}

function validateTeamComposition(team) {
  if (!team || !Array.isArray(team.units) || team.units.length === 0) {
    throw new Error("team-composition must define at least one unit.");
  }

  for (const unit of team.units) {
    if (!unit.id) {
      throw new Error("team-composition unit is missing id.");
    }
    if (!unit.briefPath) {
      throw new Error(`team-composition unit ${unit.id} is missing briefPath.`);
    }
    if (!Array.isArray(unit.writePaths) || !Array.isArray(unit.writeFiles)) {
      throw new Error(`team-composition unit ${unit.id} is missing write scope.`);
    }
    if (!Array.isArray(unit.readPaths) || !Array.isArray(unit.readFiles)) {
      throw new Error(`team-composition unit ${unit.id} is missing read scope.`);
    }
    if (!TIER_ORDER.includes(unit.verificationTier || "tier0")) {
      throw new Error(`team-composition unit ${unit.id} has an invalid verificationTier.`);
    }
  }
}

function highestTier(tiers) {
  const normalized = tiers.filter((tier) => TIER_ORDER.includes(tier));
  if (normalized.length === 0) {
    return "tier0";
  }

  return normalized.sort((left, right) => TIER_ORDER.indexOf(right) - TIER_ORDER.indexOf(left))[0];
}

function commandsForTier(profile, tier) {
  const targetIndex = TIER_ORDER.indexOf(tier);
  return TIER_ORDER.slice(0, targetIndex + 1).flatMap((level) => profile.tierCommands?.[level] || []);
}

function inferFindingRoute(artifact) {
  const value = String(artifact || "");
  if (value === "review_meta" || value.includes("coverage_incomplete")) {
    return "review_meta";
  }
  if (value.startsWith("specs/") || value === "plan.md") {
    return "spec";
  }
  if (value.startsWith("tests/") || value.startsWith("red/")) {
    return "test";
  }
  if (value.startsWith("verification/")) {
    return "verification";
  }
  return "impl";
}

function currentReviewScopeForPhase(state) {
  if (["planned", "plan_reviewed"].includes(state.phase)) {
    return "plan";
  }
  if (["verified", "impl_reviewed"].includes(state.phase)) {
    return "impl";
  }
  return null;
}

export async function loadEffectiveTeamComposition(repoRoot, feature) {
  const root = featureRoot(repoRoot, feature);
  const baseSource = await readJson(path.join(root, "team-composition.json"));
  const base = baseSource ? normalizeTeamComposition(baseSource) : null;
  if (!base) {
    throw new Error(`Missing team-composition.json for ${feature}`);
  }

  const patchSource = await readJson(path.join(root, "team-composition.patch.json"));
  const patch = patchSource
    ? {
        ...patchSource,
        temporaryUnits: Array.isArray(patchSource.temporaryUnits)
          ? patchSource.temporaryUnits.map((unit) => normalizeUnitDefinition(unit))
          : []
      }
    : null;
  if (!patch || !Array.isArray(patch.temporaryUnits) || patch.temporaryUnits.length === 0) {
    validateTeamComposition(base);
    return base;
  }

  const effective = {
    ...base,
    patch,
    units: [...base.units, ...patch.temporaryUnits]
  };
  validateTeamComposition(effective);
  return effective;
}

async function hashFileIfExists(targetPath) {
  if (!(await pathExists(targetPath))) {
    return null;
  }

  return sha256Text(await fs.readFile(targetPath, "utf8"));
}

async function updateReviewerJobs(repoRoot, feature, nextJobs) {
  await writeJson(reviewerJobsPath(repoRoot, feature), nextJobs);
}

function isTeamRequiredPhase(phase) {
  return phase === "red" || phase === "fix_required";
}

export async function generatePlanArtifacts(repoRoot, feature, options = {}) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "plan");
  if (options.goal) {
    state.goal = options.goal;
  }
  if (options.title) {
    state.title = options.title;
  }

  const root = featureRoot(repoRoot, feature);
  const requirements = buildRequirements(state);
  const timestamp = nowIso();
  const team = buildTeamComposition(state);
  validateTeamComposition(team);

  state.approvals.plan = false;
  state.approvals.implementation = false;
  state.reviewIterations.plan = 0;
  state.reviewIterations.impl = 0;
  state.lastAggregate.plan = null;
  state.lastAggregate.impl = null;

  await writeText(path.join(root, "plan.md"), renderPlanMarkdown(state, requirements, team));
  await writeText(path.join(root, "specs/behavioral-spec.md"), renderBehavioralSpec(state));
  await writeJson(path.join(root, "specs/requirements-index.json"), {
    generatedAt: timestamp,
    feature,
    requirements
  });
  await writeText(
    path.join(root, "specs/verification-architecture.md"),
    renderVerificationArchitecture(state)
  );
  await writeText(path.join(root, "specs/test-strategy.md"), renderTestStrategy(state));
  await writeText(
    path.join(root, "specs/convergence-checklist.md"),
    renderConvergenceChecklist(
      {
        ...state,
        phase: "planned"
      },
      false
    )
  );
  await writeJson(path.join(root, "team-composition.json"), team);
  await writeJson(path.join(root, "config.json"), buildFeatureConfig(state));
  await writeJson(path.join(root, "verification/profile.json"), buildVerificationProfile(state));
  await writeText(path.join(root, "contexts/planner-brief.md"), renderPlannerBrief(state, team));
  await writeText(path.join(root, "contexts/repo-pointers.md"), renderRepoPointers(state));
  for (const unit of team.units) {
    await writeText(
      path.join(root, unit.briefPath),
      renderUnitBrief(state, unit)
    );
    await ensureDir(path.join(root, "workspace/runtime", unit.id));
  }

  await writeJson(path.join(root, "traceability/coverage-matrix.json"), {
    generatedAt: timestamp,
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      units: requirement.units,
      verification: requirement.id === "REQ-1"
        ? ["invalid-start TypeError", "invalid-end TypeError", "descending RangeError"]
        : requirement.id === "REQ-4"
          ? ["sumRange single-point", "sumRange zero-crossing-or-negative"]
          : requirement.id === "REQ-5"
            ? ["describeRange single-point", "describeRange zero-crossing-or-negative", "describeRange fractional-average"]
            : requirement.id === "REQ-7"
              ? ["node:test validation coverage", "src/range.js static diff review"]
              : ["npm test"]
    }))
  });

  await appendJsonl(path.join(root, "traceability/contract-chain.jsonl"), {
    ts: timestamp,
    type: "plan_generated",
    feature,
    requirements: requirements.map(({ id, title }) => ({ id, title }))
  });
  for (const requirement of requirements) {
    for (const unitId of requirement.units) {
      await appendTraceability(repoRoot, feature, {
        type: "requirement_routed",
        requirementId: requirement.id,
        unitId
      });
    }
  }
  await updateReviewerJobs(repoRoot, feature, []);
  await appendRunMetadata(repoRoot, feature, {
    command: "plan",
    kind: "model_invocation",
    status: "completed",
    detail: {
      feature,
      goal: state.goal,
      requirementCount: requirements.length
    }
  });

  state.phase = "planned";
  await saveState(repoRoot, feature, state);
  return state;
}

function buildRequirements(state) {
  return [
    {
      id: "REQ-1",
      title: "Preserve exact validation contract",
      summary:
        "New helpers must preserve exact TypeError/RangeError behavior and messages for invalid input.",
      units: ["sample-logic"]
    },
    {
      id: "REQ-2",
      title: "Add sumRange",
      summary: "Implement sumRange(start, end) in the sample app range module.",
      units: ["sample-logic"]
    },
    {
      id: "REQ-3",
      title: "Add describeRange",
      summary:
        "Implement describeRange(start, end) with start, end, count, values, sum, and average.",
      units: ["sample-logic"]
    },
    {
      id: "REQ-4",
      title: "Representative sumRange cases",
      summary:
        "Verification must cover at least one single-point and one zero-crossing or negative range for sumRange.",
      units: ["sample-tests"]
    },
    {
      id: "REQ-5",
      title: "Representative describeRange cases",
      summary:
        "Verification must cover single-point, zero-crossing or negative ranges, and at least one case with a fractional average.",
      units: ["sample-tests"]
    },
    {
      id: "REQ-6",
      title: "Export from index",
      summary: "Export the new range helpers from src/index.js.",
      units: ["sample-logic"]
    },
    {
      id: "REQ-7",
      title: "Cover with tests and static reuse review",
      summary:
        "Add node:test coverage for valid cases plus start-invalid, end-invalid, and descending range failures with exact error expectations, and record static review evidence that the new helpers reuse normalizeRange/listRange/sum.",
      units: ["sample-tests", "sample-logic"]
    }
  ];
}

function buildTeamComposition(state) {
  return {
    feature: state.feature,
    generatedAt: nowIso(),
    maxParallel: 2,
    planner: {
      provider: "claude",
      model: "opus",
      effort: "xhigh"
    },
    reviewers: {
      provider: "codex",
      model: "gpt-5.4",
      effort: "high"
    },
    implementers: {
      provider: "claude",
      model: "sonnet",
      effort: "high"
    },
    units: [
      {
        id: "sample-logic",
        role: "implementer",
        paths: ["src/range.js", "src/index.js"],
        dependsOn: [],
        writePaths: ["src/"],
        writeFiles: ["src/range.js", "src/index.js"],
        readPaths: ["src/", "tests/"],
        readFiles: ["tests/range.test.js"],
        verificationTier: "tier0",
        briefPath: "contexts/unit-sample-logic.md"
      },
      {
        id: "sample-tests",
        role: "tester",
        paths: ["tests/range.test.js"],
        dependsOn: ["sample-logic"],
        writePaths: ["tests/"],
        writeFiles: ["tests/range.test.js"],
        readPaths: ["src/", "tests/"],
        readFiles: ["src/range.js", "src/index.js"],
        verificationTier: "tier0",
        briefPath: "contexts/unit-sample-tests.md"
      }
    ]
  };
}

function renderPlanMarkdown(state, requirements, team) {
  return [
    `# ${state.title}`,
    "",
    "## Goal",
    "",
    state.goal,
    "",
    "## Target Repo",
    "",
    `- Path: \`${state.targetRepoRelative}\``,
    `- Verify: \`${state.verifyCommand}\``,
    "",
    "## Requirements",
    "",
    ...requirements.map((requirement) => `- ${requirement.id}: ${requirement.summary}`),
    "",
    "## Team Composition",
    "",
    ...team.units.map(
      (unit) =>
        `- ${unit.id}: ${unit.role} -> ${unit.paths.join(", ")}${
          unit.dependsOn.length ? ` (depends on ${unit.dependsOn.join(", ")})` : ""
        }`
    ),
    ""
  ].join("\n");
}

function renderBehavioralSpec(state) {
  return [
    "# Behavioral Spec",
    "",
    `Feature: ${state.feature}`,
    "",
    "The sample app must expose range aggregation helpers that operate on inclusive integer ranges.",
    "",
    "Expected behavior:",
    "",
    "- `sumRange(start, end)` and `describeRange(start, end)` must reuse the current validation path so behavior stays aligned with `normalizeRange`, `listRange`, and `sum`.",
    "- Non-integer `start` must throw `TypeError(\"start must be an integer\")`.",
    "- Non-integer `end` must throw `TypeError(\"end must be an integer\")`.",
    "- Descending ranges must throw `RangeError(\"start must be less than or equal to end\")`.",
    "- `sumRange(start, end)` returns the inclusive sum between the edges.",
    "- `describeRange(start, end)` returns `{ start, end, count, values, sum, average }`.",
    "- `describeRange` verification must cover a single-point range, a zero-crossing or negative range, and a range whose average is fractional."
  ].join("\n");
}

function renderVerificationArchitecture(state) {
  return [
    "# Verification Architecture",
    "",
    `- Live target: \`${state.targetRepoRelative}\``,
    "- Workspace base is immutable.",
    "- Workspace repo is the only writable implementation copy.",
    "- Stage compares workspace base and workspace repo deterministically.",
    "- Apply verifies baseline hashes against the live target repo before writing.",
    `- Verify executes \`${state.verifyCommand}\` in the live target repo and persists stdout/stderr.`,
    "",
    "Requirement-to-verification matrix:",
    "",
    "- REQ-1: exact `TypeError`/`RangeError` behavior is asserted in node:test for invalid `start`, invalid `end`, and descending ranges.",
    "- REQ-2: `sumRange(start, end)` is asserted against inclusive sums.",
    "- REQ-3: `describeRange(start, end)` is asserted for object shape and aggregate values.",
    "- REQ-4: `sumRange` representative inputs include a single-point range and a zero-crossing or negative range.",
    "- REQ-5: `describeRange` representative inputs include single-point, zero-crossing or negative values, and a fractional average.",
    "- REQ-6: `src/index.js` export surface is asserted by importing the public entrypoint.",
    "- REQ-7: implementation review must inspect the `src/range.js` diff and confirm the new helpers call `normalizeRange`, `listRange`, and/or `sum` instead of duplicating range math."
  ].join("\n");
}

function renderTestStrategy() {
  return [
    "# Test Strategy",
    "",
    "- Keep the existing `node:test` runner.",
    "- Cover happy path for `sumRange` and `describeRange`.",
    "- Cover exact validation behavior for invalid `start` and invalid `end` with message checks.",
    "- Cover descending range rejection with `RangeError` and the existing message.",
    "- Cover representative `describeRange` cases: single-point, zero-crossing or negative values, and fractional average.",
    "- Validate aggregate values, `values` ordering, `count`, and exported surface."
  ].join("\n");
}

function renderConvergenceChecklist(state, verified) {
  const planned = state.phase !== "initialized";
  const planApproved = Boolean(state.approvals.plan);
  const redPrepared =
    state.phase === "red" ||
    state.phase === "implemented" ||
    state.phase === "staged" ||
    state.phase === "applied" ||
    state.phase === "verified" ||
    state.phase === "impl_reviewed" ||
    state.phase === "done";
  const implementationComplete =
    state.phase === "implemented" ||
    state.phase === "staged" ||
    state.phase === "applied" ||
    state.phase === "verified" ||
    state.phase === "impl_reviewed" ||
    state.phase === "done";
  const implementationApproved = Boolean(state.approvals.implementation);

  return [
    "# Convergence Checklist",
    "",
    `- [x] Feature initialized: ${state.feature}`,
    `- [${planned ? "x" : " "}] Plan written`,
    `- [${planApproved ? "x" : " "}] Plan approved`,
    `- [${redPrepared ? "x" : " "}] Red artifacts created`,
    `- [${implementationComplete ? "x" : " "}] Implementation complete`,
    `- [${verified ? "x" : " "}] Verification green`,
    `- [${implementationApproved ? "x" : " "}] Implementation approved`
  ].join("\n");
}

function renderPlannerBrief(state, team) {
  const targetRangePath = `${state.targetRepoRelative}/src/range.js`;
  const targetTestPath = `${state.targetRepoRelative}/tests/range.test.js`;
  return [
    "# Planner Brief",
    "",
    `Goal: ${state.goal}`,
    "",
    "Drive the feature through the trusted CLI. Keep all canonical state under `.mavsdd/`.",
    "The existing sample implementation already exposes `normalizeRange`, `listRange`, and `sum`; plan around reusing them instead of duplicating logic.",
    `Baseline evidence before planning: \`${targetRangePath}\` defines \`normalizeRange\`, \`listRange\`, and \`sum\`, and \`${targetTestPath}\` already proves \`sum(listRange(1, 4)) === 10\`.`,
    "",
    "Units:",
    "",
    ...team.units.map((unit) => `- ${unit.id}: ${unit.role}`)
  ].join("\n");
}

function renderRepoPointers(state) {
  return [
    "# Repo Pointers",
    "",
    `- Target repo: \`${state.targetRepoRelative}\``,
    "- Range logic lives in `src/range.js`.",
    "- `src/range.js` already exposes `normalizeRange`, `listRange`, and `sum`; new helpers should reuse them.",
    "- `normalizeRange` owns the exact error types and messages for invalid input.",
    "- Public exports live in `src/index.js`.",
    "- Tests live in `tests/range.test.js` and should prove both the aggregate values and the validation contract.",
    "- Baseline verification command is `npm test`; current plan artifacts assume the pre-change suite is green."
  ].join("\n");
}

function renderUnitBrief(state, unit) {
  return [
    `# Unit ${unit.id}`,
    "",
    `Role: ${unit.role}`,
    "",
    `Target repo: \`${state.targetRepoRelative}\``,
    "",
    `Paths: ${unit.paths.join(", ")}`,
    unit.dependsOn.length ? `Depends on: ${unit.dependsOn.join(", ")}` : "Depends on: none",
    "",
    "Implementation note: preserve the existing `normalizeRange` contract and prefer reuse over duplicate range logic."
  ].join("\n");
}

export async function generateRedArtifacts(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "red", ["plan_approved"]);
  const root = featureRoot(repoRoot, feature);
  const redArtifacts = {
    feature,
    generatedAt: nowIso(),
    expectedFailingTests: [
      {
        id: "RED-1",
        command: "node --test tests/range.test.js",
        description: "describeRange should expose count, sum, and average"
      },
      {
        id: "RED-2",
        command: "node --test tests/range.test.js",
        description: "sumRange should reject invalid descending ranges"
      }
    ]
  };

  await writeJson(path.join(root, "red/test-matrix.json"), redArtifacts);
  await writeJson(path.join(root, "red/failing-tests.json"), redArtifacts.expectedFailingTests);
  await writeText(
    path.join(root, "red/red-phase.log"),
    [
      `[${redArtifacts.generatedAt}] Red phase prepared for ${feature}.`,
      "Expected new tests are documented but not yet applied to the live target."
    ].join("\n")
  );
  await appendTraceability(repoRoot, feature, {
    type: "red_evidence_bound",
    feature,
    evidence: "red/test-matrix.json"
  });

  state.phase = "red";
  await writeText(path.join(root, "specs/convergence-checklist.md"), renderConvergenceChecklist(state, false));
  await saveState(repoRoot, feature, state);
  await appendRunMetadata(repoRoot, feature, {
    command: "red",
    kind: "model_invocation",
    status: "completed",
    detail: {
      feature,
      expectedFailingTests: redArtifacts.expectedFailingTests.length
    }
  });
  return state;
}

export async function materializeWorkspaces(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  const root = featureRoot(repoRoot, feature);
  const baseDir = path.join(root, "workspace/base");
  const repoDir = path.join(root, "workspace/repo");
  const teamComposition = await loadEffectiveTeamComposition(repoRoot, feature);

  await resetDirectory(baseDir);
  await resetDirectory(repoDir);
  await copyTree(state.targetRepo, baseDir);
  await copyTree(state.targetRepo, repoDir);

  const baselineManifest = await buildFileManifest(baseDir);
  const baselineFilesJson = JSON.stringify(baselineManifest, Object.keys(baselineManifest).sort());
  const baselineId = `base-${sha256Text(`${feature}:${baselineFilesJson}`).slice(0, 12)}`;
  const repoHead = detectRepoHead(state.targetRepo);
  await writeJson(path.join(root, "workspace/baseline-manifest.json"), {
    baselineId,
    repoHead,
    generatedAt: nowIso(),
    files: baselineManifest
  });
  state.workspace = {
    ...(state.workspace || {}),
    baselineId,
    repoHead,
    materializedAt: nowIso()
  };
  await saveState(repoRoot, feature, state);
  for (const unit of teamComposition.units) {
    await ensureDir(path.join(root, "workspace/runtime", unit.id));
  }
  await appendRunMetadata(repoRoot, feature, {
    command: "materialize-workspaces",
    kind: "orchestration",
    status: "completed",
    detail: {
      feature,
      unitCount: teamComposition.units.length
    }
  });

  return { state, root, baseDir, repoDir };
}

async function resetDirectory(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
  await ensureDir(targetPath);
}

async function copyTree(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    if ([".git", "node_modules", ".mavsdd"].includes(entry.name)) {
      continue;
    }

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await ensureDir(destinationPath);
      await copyTree(sourcePath, destinationPath);
      continue;
    }

    await ensureDir(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath);
  }
}

export async function runClaudeImplementation(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "implement");
  try {
    ensureAgentTeamsPreflight(repoRoot);
    ensureClaudePreflight(repoRoot);
  } catch (error) {
    await appendRunMetadata(repoRoot, feature, {
      command: "implement",
      kind: "model_invocation",
      status: "rejected",
      policyDecision: "deny",
      policyReason: error.message,
      detail: {
        feature
      }
    });
    throw error;
  }
  await appendRunMetadata(repoRoot, feature, {
    command: "implement",
    kind: "model_invocation",
    status: "started",
    detail: { feature, step: "materialize" }
  });
  process.stderr.write(`[mavsdd] implement: materializing workspace for ${feature}...\n`);
  const materialize = await materializeWorkspaces(repoRoot, feature);
  const root = materialize.root;
  const repoDir = materialize.repoDir;
  Object.assign(state, materialize.state);
  process.stderr.write(`[mavsdd] implement: spawning Claude agent team for ${feature}...\n`);
  await appendRunMetadata(repoRoot, feature, {
    command: "implement",
    kind: "model_invocation",
    status: "started",
    detail: { feature, step: "spawn_agent_team" }
  });
  const teamComposition = await loadEffectiveTeamComposition(repoRoot, feature);
  const agents = {
    "sample-logic": {
      description: "Implements the core range logic in src files.",
      prompt:
        "Focus on source code changes in src/. Keep changes minimal and consistent with the existing style."
    },
    "sample-tests": {
      description: "Adds node:test coverage for the new range helpers.",
      prompt:
        "Focus on node:test coverage in tests/. Ensure edge cases are covered and the full suite passes."
    }
  };
  const schemaPath = path.join(root, "team-runtime/claude-implement-schema.json");
  const responsePath = path.join(root, "team-runtime/claude-implement-last-message.json");
  const rawPath = path.join(root, "team-runtime/claude-implement-raw-response.json");
  const prompt = [
    "You are implementing a feature in a sample Node.js repository.",
    "Use the available agent capability to delegate work to both `sample-logic` and `sample-tests` before you finish.",
    "Repository constraints:",
    "- Modify only files under the current working directory.",
    "- Do not touch files outside the repo.",
    "- Run `npm test` before finishing.",
    "",
    `Feature goal: ${state.goal}`,
    "",
    "Required code changes:",
    "- Add `sumRange(start, end)` to src/range.js.",
    "- Add `describeRange(start, end)` to src/range.js.",
    "- Export both functions from src/index.js.",
    "- Extend tests/range.test.js to cover the new behavior.",
    "",
    "Return JSON matching the schema."
  ].join("\n");
  const promptPayloadHash = sha256Text(prompt);

  await writeJson(schemaPath, {
    type: "object",
    additionalProperties: false,
    required: ["summary", "delegatedAgents", "changedFiles", "testsPassed"],
    properties: {
      summary: { type: "string" },
      delegatedAgents: {
        type: "array",
        items: { type: "string" }
      },
      changedFiles: {
        type: "array",
        items: { type: "string" }
      },
      testsPassed: { type: "boolean" }
    }
  });

  await writeJson(path.join(root, "team-runtime/team-state.json"), {
    feature,
    status: "running",
    executor: "claude-cli-agent-team",
    units: teamComposition.units,
    updatedAt: nowIso()
  });

  await appendJsonl(path.join(root, "team-runtime/task-ledger.jsonl"), {
    ts: nowIso(),
    phase: "implemented",
    event: "claude_team_started",
    agents: Object.keys(agents)
  });

  const result = runProcess(
    "claude",
    [
      "-p",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--json-schema",
      await fs.realpath(schemaPath),
      "--agents",
      JSON.stringify(agents),
      "-"
    ],
    {
      cwd: repoDir,
      input: prompt,
      env: {
        ...process.env,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"
      },
      timeoutMs: Number(process.env.MAVSDD_IMPLEMENT_TIMEOUT_MS) || 15 * 60 * 1000
    }
  );

  await writeJson(rawPath, {
    command: "claude",
    args: [
      "-p",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--json-schema",
      schemaPath,
      "--agents",
      agents
    ],
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    promptPayloadHash
  });

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(extractClaudeJson(result.stdout));
    await writeJson(responsePath, parsed);
  } catch (error) {
    parseError = error;
  }

  if (parseError || result.status !== 0 || !parsed?.testsPassed) {
    const failureSummary = parseError
      ? `failed to parse response: ${parseError.message}`
      : result.status !== 0
        ? `claude exit code ${result.status}`
        : "agent reported testsPassed=false";
    await appendRunMetadata(repoRoot, feature, {
      command: "implement",
      kind: "model_invocation",
      status: "failed",
      policyDecision: "fail_closed",
      policyReason: failureSummary,
      detail: {
        feature,
        exitCode: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
        rawResponsePath: rawPath
      }
    });
    process.stderr.write(
      `[mavsdd] implement: ${failureSummary}. See ${rawPath} for full agent output.\n`
    );
    throw new Error(
      `Claude implementation failed: ${failureSummary}. Details written to ${rawPath}`
    );
  }

  for (const unit of teamComposition.units) {
    await writeJson(path.join(root, "implementations", unit.id, "status.json"), {
      unit: unit.id,
      status: parsed.changedFiles.some((file) => unit.paths.includes(file))
        ? "implemented"
        : "unchanged",
      updatedAt: nowIso(),
      changedFiles: parsed.changedFiles.filter((file) => unit.paths.includes(file))
    });
  }

  state.phase = "implemented";
  await saveState(repoRoot, feature, state);
  await appendJsonl(path.join(root, "team-runtime/task-ledger.jsonl"), {
    ts: nowIso(),
    phase: "implemented",
    event: "claude_team_finished",
    summary: parsed.summary,
    delegatedAgents: parsed.delegatedAgents
  });
  await appendRunMetadata(repoRoot, feature, {
    command: "implement",
    kind: "model_invocation",
    status: "completed",
    provider: "anthropic",
    requestedModel: "sonnet",
    resolvedModel: "sonnet",
    requestedEffort: "high",
    resolvedEffort: "high",
    promptPayloadHash,
    detail: {
      feature,
      delegatedAgents: parsed.delegatedAgents,
      changedFiles: parsed.changedFiles
    }
  });
  return parsed;
}

function extractClaudeJson(stdout) {
  const parsed = JSON.parse(stdout);
  if (typeof parsed.result === "string") {
    return parsed.result;
  }
  return JSON.stringify(parsed.result);
}

export async function stageOperations(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "stage");
  const root = featureRoot(repoRoot, feature);
  const baseDir = path.join(root, "workspace/base");
  const repoDir = path.join(root, "workspace/repo");
  const baseManifest = await buildDiffManifest(baseDir);
  const repoManifest = await buildDiffManifest(repoDir);
  const teamComposition = await loadEffectiveTeamComposition(repoRoot, feature);
  const operationsByUnit = new Map(teamComposition.units.map((unit) => [unit.id, []]));
  const baselineManifest = await readJson(
    path.join(root, "workspace/baseline-manifest.json"),
    { files: {} }
  );

  const operations = await diffToOperations({ baseManifest, repoManifest, repoDir });

  for (const operation of operations) {
    const touchedPaths = operationPaths(operation);
    const ownersByPath = touchedPaths.map((relativePath) => ({
      relativePath,
      owners: findOwningUnits(teamComposition.units, relativePath)
    }));
    for (const { relativePath, owners } of ownersByPath) {
      if (owners.length === 0) {
        throw new Error(`Changed path is outside the effective write scope: ${relativePath}`);
      }
      if (owners.length > 1) {
        throw new Error(`Changed path is claimed by multiple units: ${relativePath}`);
      }
    }
    const ownerSet = new Set(ownersByPath.map(({ owners }) => owners[0].id));
    if (ownerSet.size > 1) {
      throw new Error(
        `Rename crosses unit boundaries: ${operation.from} → ${operation.to}`
      );
    }
    const unitId = [...ownerSet][0];
    if (operation.baseHash === null && baselineManifest.files?.[operation.path]?.sha256) {
      operation.baseHash = baselineManifest.files[operation.path].sha256;
    }
    const target = operationsByUnit.get(unitId) || [];
    target.push(operation);
    operationsByUnit.set(unitId, target);
  }

  for (const [unitId, operations] of operationsByUnit.entries()) {
    validateOperationsAgainstBaseline(operations, baselineManifest.files || {});
    await ensureDir(path.join(root, "operations", unitId));
    const manifest = {
      feature,
      unitId,
      baselineId: baselineManifest.baselineId ?? null,
      generatedAt: nowIso(),
      operations
    };
    await assertValid("mavsdd-operations", manifest, `operations/${unitId}`);
    await writeJson(path.join(root, "operations", unitId, "operations.json"), manifest);
    await appendTraceability(repoRoot, feature, {
      type: "operations_generated",
      unitId,
      artifact: path.join("operations", unitId, "operations.json")
    });
  }

  state.phase = "staged";
  await saveState(repoRoot, feature, state);
  await appendRunMetadata(repoRoot, feature, {
    command: "stage",
    kind: "orchestration",
    status: "completed",
    detail: {
      feature,
      unitCount: teamComposition.units.length,
      changedFileCount: Object.values(Object.fromEntries(operationsByUnit)).flat().length
    }
  });
  return {
    feature,
    operationsByUnit: Object.fromEntries(operationsByUnit)
  };
}

export async function applyOperations(repoRoot, feature, options = {}) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "apply");
  const root = featureRoot(repoRoot, feature);

  const operationsDir = path.join(root, "operations");
  const unitDirs = await fs.readdir(operationsDir);
  const manifestsByUnit = [];
  const perUnitBaselineIds = new Set();
  for (const unit of unitDirs) {
    const manifest = await readJson(path.join(operationsDir, unit, "operations.json"), { operations: [] });
    manifestsByUnit.push({ unit, manifest });
    if (manifest.baselineId) perUnitBaselineIds.add(manifest.baselineId);
  }
  if (perUnitBaselineIds.size > 1) {
    throw new Error(
      `operations.json baselineId mismatch across units: ${[...perUnitBaselineIds].join(", ")}`
    );
  }
  const baselineId = [...perUnitBaselineIds][0] ?? null;
  const opDigestSource = manifestsByUnit
    .flatMap(({ unit, manifest }) =>
      (manifest.operations || []).map((operation) =>
        JSON.stringify({
          unit,
          op: operation.op ?? operation.kind,
          path: operation.path ?? null,
          from: operation.from ?? null,
          to: operation.to ?? null,
          baseHash: operation.baseHash ?? null,
          contentHash: operation.contentHash ?? operation.newHash ?? null,
          mode: operation.mode ?? null
        })
      )
    )
    .sort()
    .join("|");
  const applyTxnId = `apply-${sha256Text(
    `${feature}::${baselineId ?? "no-baseline"}::${opDigestSource}`
  ).slice(0, 12)}`;

  const applyLogPath = path.join(root, "apply-log.jsonl");
  if (await pathExists(applyLogPath)) {
    const logBody = await fs.readFile(applyLogPath, "utf8");
    const committedTxn = logBody
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && entry.applyTxnId === applyTxnId && entry.status === "committed");
    if (committedTxn.length > 0) {
      await appendRunMetadata(repoRoot, feature, {
        command: "apply",
        kind: "orchestration",
        status: "skipped",
        detail: { feature, applyTxnId, reason: "idempotent_same_txn_already_committed" }
      });
      return {
        feature,
        applyTxnId,
        appliedCount: committedTxn[0].appliedCount ?? 0,
        idempotent: true
      };
    }
  }

  const lockAlready = await isLocked(repoRoot);
  if (lockAlready && !options.inheritLock) {
    throw new Error(`Apply lock already exists: ${path.join(repoRoot, ".mavsdd/.apply-lock")}`);
  }
  const nonce = options.nonce ?? generateNonce();
  if (!options.inheritLock) {
    await acquireLock(repoRoot, {
      feature,
      pid: process.pid,
      nonce,
      applyTxnId,
      baselineId,
      status: "running"
    });
  }

  try {
    let appliedCount = 0;

    for (const { unit, manifest } of manifestsByUnit) {
      for (const operation of manifest.operations) {
        const op = operation.op
          ?? (operation.kind === "modify"
            ? OP_OVERWRITE
            : operation.kind === "add"
              ? OP_ADD
              : operation.kind === "delete"
                ? OP_DELETE
                : operation.kind);
        appliedCount += await applySingleOperation(state, op, operation);
      }
    }

    await appendJsonl(path.join(root, "apply-log.jsonl"), {
      ts: nowIso(),
      applyTxnId,
      status: "committed",
      feature,
      appliedCount
    });
    state.phase = "applied";
    await saveState(repoRoot, feature, state);
    await appendRunMetadata(repoRoot, feature, {
      command: "apply",
      kind: "orchestration",
      status: "completed",
      detail: {
        feature,
        applyTxnId,
        appliedCount
      }
    });
    return {
      feature,
      applyTxnId,
      appliedCount
    };
  } catch (error) {
    await appendJsonl(path.join(root, "apply-log.jsonl"), {
      ts: nowIso(),
      applyTxnId,
      status: "rolled_back",
      feature,
      error: error.message
    });
    await appendRunMetadata(repoRoot, feature, {
      command: "apply",
      kind: "orchestration",
      status: "failed",
      detail: {
        feature,
        applyTxnId,
        error: error.message
      }
    });
    throw error;
  } finally {
    if (!options.inheritLock) {
      await releaseLock(repoRoot);
    }
  }
}

export async function applyOperationsInSubprocess(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  const nonce = generateNonce();
  await acquireLock(repoRoot, { feature, pid: process.pid, nonce });
  try {
    const workerPath = path.join(repoRoot, "scripts/cli/apply-worker.mjs");
    const relativeWorker = workerPath.startsWith(repoRoot)
      ? workerPath
      : path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../scripts/cli/apply-worker.mjs");
    const env = {
      ...process.env,
      MAVSDD_APPLY_TOKEN: nonce,
      MAVSDD_APPLY_PARENT_PID: String(process.pid),
      MAVSDD_APPLY_FEATURE: feature,
      MAVSDD_REPO_ROOT: repoRoot
    };
    const result = runProcess("node", [relativeWorker], { cwd: repoRoot, env });
    if (result.status !== 0) {
      throw new Error(`apply-worker failed (status=${result.status}): ${result.stderr || result.stdout}`);
    }
    state.phase = "applied";
    await saveState(repoRoot, feature, state);
    await appendRunMetadata(repoRoot, feature, {
      command: "apply",
      kind: "orchestration",
      status: "completed",
      detail: { feature, subprocess: true }
    });
    return { feature, subprocess: true };
  } finally {
    await releaseLock(repoRoot);
  }
}

export async function runVerification(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "verify");
  const root = featureRoot(repoRoot, feature);
  const teamComposition = await loadEffectiveTeamComposition(repoRoot, feature);
  const profilePath = path.join(root, "verification/profile.json");
  const profile = normalizeVerificationProfile(await readJson(profilePath), state);
  await writeJson(profilePath, profile);
  const requestedTier = "auto";
  const effectiveTier = highestTier(teamComposition.units.map((unit) => unit.verificationTier || "tier0"));
  const commands = commandsForTier(profile, effectiveTier);
  const commandResults = [];
  const startedAt = Date.now();

  for (const command of commands) {
    const result = runShellCommand(command, state.targetRepo);
    commandResults.push({
      command,
      exitCode: result.status,
      success: result.status === 0,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }

  const summary = {
    feature,
    command: state.verifyCommand,
    exitCode: commandResults.find((result) => !result.success)?.exitCode ?? 0,
    success: commandResults.every((result) => result.success),
    durationMs: Date.now() - startedAt,
    stdout: commandResults.map((result) => result.stdout).join("\n").trim(),
    stderr: commandResults.map((result) => result.stderr).join("\n").trim(),
    generatedAt: nowIso(),
    requestedTier,
    effectiveTier,
    unitResults: teamComposition.units.map((unit) => ({
      unit: unit.id,
      verificationTier: unit.verificationTier || "tier0",
      success: commandResults.every((result) => result.success),
      commands: commands
    })),
    overallVerdict: commandResults.every((result) => result.success) ? "PASS" : "FAIL",
    failedUnits: commandResults.every((result) => result.success)
      ? []
      : teamComposition.units.map((unit) => unit.id),
    commands: commandResults
  };

  await writeJson(path.join(root, "verification/summary.json"), summary);
  await writeJson(path.join(root, "verification/profile.json"), {
    ...profile,
    generatedAt: nowIso(),
    targetRepo: state.targetRepoRelative,
    verifyCommand: state.verifyCommand,
    success: summary.success
  });
  for (const unit of teamComposition.units) {
    await writeText(
      path.join(root, "verification/reports", `${unit.id}.md`),
      [
        `# Verification Report: ${unit.id}`,
        "",
        `- Command: \`${state.verifyCommand}\``,
        `- Effective tier: ${effectiveTier}`,
        `- Exit code: ${summary.exitCode}`,
        `- Success: ${summary.success}`,
        `- Paths: ${unit.paths.join(", ")}`,
        "",
        "## Stdout",
        "",
        "```text",
        summary.stdout.trim(),
        "```",
        "",
        "## Stderr",
        "",
        "```text",
        summary.stderr.trim(),
        "```"
      ].join("\n")
    );
  }

  await writeText(
    path.join(root, "specs/convergence-checklist.md"),
    renderConvergenceChecklist(
      {
        ...state,
        approvals: state.approvals
      },
      summary.success
    )
  );

  state.phase = summary.success ? "verified" : "fix_required";
  await saveState(repoRoot, feature, state);
  await appendTraceability(repoRoot, feature, {
    type: "verification_recorded",
    overallVerdict: summary.overallVerdict,
    artifact: "verification/summary.json"
  });
  await appendRunMetadata(repoRoot, feature, {
    command: "verify",
    kind: "orchestration",
    status: summary.success ? "completed" : "failed",
    detail: {
      feature,
      exitCode: summary.exitCode,
      command: state.verifyCommand
    }
  });
  return summary;
}

export async function runReview(repoRoot, feature, scope, options = {}) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, `${scope}-review`);
  try {
    ensureCodexPreflight(repoRoot);
  } catch (error) {
    await appendRunMetadata(repoRoot, feature, {
      command: scope === "plan" ? "plan-review" : "impl-review",
      kind: "model_invocation",
      status: "rejected",
      policyDecision: "deny",
      policyReason: error.message,
      detail: {
        feature,
        scope
      }
    });
    throw error;
  }
  const root = featureRoot(repoRoot, feature);
  const teamComposition = await loadEffectiveTeamComposition(repoRoot, feature);
  const iteration = (state.reviewIterations[scope] || 0) + 1;
  const iterationDir = path.join(root, "reviews", scope, `iteration-${iteration}`);
  const reviewers = Number(options.reviewers || 1);
  const reviewTimeoutMs = Number(options["timeout-ms"] || process.env.MAVSDD_REVIEW_TIMEOUT_MS || 60_000);
  const artifacts = scope === "plan"
    ? [
        ...PLAN_ARTIFACTS,
        ...teamComposition.units
          .map((unit) => unit.briefPath)
          .filter((p) => typeof p === "string" && p.length > 0)
      ]
    : IMPL_ARTIFACTS.flatMap((item) => {
        if (item === "operations") {
          return gatherOperationArtifacts(root, teamComposition.units);
        }
        if (item === "implementations") {
          return gatherImplementationArtifacts(root, teamComposition.units);
        }
        return [item];
      });
  const schemaPath = path.join(iterationDir, "review-schema.json");
  const manifest = {
    feature,
    scope,
    iteration,
    snapshotId: `${scope}-iteration-${iteration}`,
    generatedAt: nowIso(),
    artifactsToReview: artifacts.map((relativePath) => ({ path: relativePath, source: "feature-root" }))
  };
  const artifactPayload = {};

  await ensureDir(iterationDir);
  await writeJson(path.join(iterationDir, "manifest.json"), manifest);
  await writeJson(schemaPath, reviewSchema());
  await updateReviewerJobs(
    repoRoot,
    feature,
    Array.from({ length: reviewers }, (_, index) => ({
      scope,
      iteration,
      reviewer: `reviewer-${index + 1}`,
      status: "pending",
      manifestPath: path.relative(root, path.join(iterationDir, "manifest.json")),
      aggregatePath: path.relative(root, path.join(iterationDir, "aggregate.json")),
      startedAt: null,
      completedAt: null,
      error: null
    }))
  );

  for (const relativePath of artifacts) {
    const absolutePath = path.join(root, relativePath);
    if (!(await pathExists(absolutePath))) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      continue;
    }

    artifactPayload[relativePath] = await fs.readFile(absolutePath, "utf8");
  }

  const digests = Object.fromEntries(
    Object.entries(artifactPayload).map(([relativePath, content]) => [
      relativePath,
      {
        sha256: sha256Text(content),
        bytes: Buffer.byteLength(content)
      }
    ])
  );
  await writeJson(path.join(iterationDir, "artifact-digests.json"), digests);
  let hadFailures = false;

  for (let reviewerIndex = 1; reviewerIndex <= reviewers; reviewerIndex += 1) {
    const reviewerDir = path.join(iterationDir, `reviewer-${reviewerIndex}`);
    await ensureDir(reviewerDir);
    await writeText(
      path.join(reviewerDir, "read-set.jsonl"),
      Object.entries(digests)
        .map(([relativePath, digest]) => JSON.stringify({ artifact: relativePath, ...digest }))
        .join("\n") + "\n"
    );

    const prompt = [
      `You are reviewer ${reviewerIndex} for scope ${scope}.`,
      "Review the provided artifacts and return a verdict.",
      "You must be strict about gaps in requirements, verification, and implementation evidence.",
      "",
      JSON.stringify(
        {
          manifest,
          artifacts: artifactPayload
        },
        null,
        2
      )
    ].join("\n");
    const promptPayloadHash = sha256Text(prompt);

    await writeText(path.join(reviewerDir, "prompt.md"), prompt);
    const verdictPath = path.join(reviewerDir, "verdict.raw.json");
    await writeJson(path.join(reviewerDir, "validation-errors.json"), []);
    const jobs = await readJson(reviewerJobsPath(repoRoot, feature), []);
    const jobIndex = jobs.findIndex(
      (job) => job.scope === scope && job.iteration === iteration && job.reviewer === `reviewer-${reviewerIndex}`
    );
    if (jobIndex >= 0) {
      jobs[jobIndex] = {
        ...jobs[jobIndex],
        status: "running",
        startedAt: nowIso(),
        jobId: buildId("review-job", `${feature}:${scope}:${iteration}:reviewer-${reviewerIndex}`),
        attemptKey: `${scope}:${iteration}:reviewer-${reviewerIndex}`,
        promptPayloadHash,
        snapshotId: manifest.snapshotId,
        readSetPath: path.relative(root, path.join(reviewerDir, "read-set.jsonl")),
        rawResponsePath: path.relative(root, path.join(reviewerDir, "raw-response.json")),
        verdictPath: path.relative(root, path.join(reviewerDir, "verdict.json"))
      };
      await updateReviewerJobs(repoRoot, feature, jobs);
    }
    const result = runProcess(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--model",
        String(options.model || "gpt-5.4"),
        "--output-schema",
        await fs.realpath(schemaPath),
        "--output-last-message",
        verdictPath,
        "-"
      ],
      {
        cwd: repoRoot,
        input: prompt,
        timeoutMs: reviewTimeoutMs
      }
    );

    await writeJson(path.join(reviewerDir, "raw-response.json"), {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      promptPayloadHash,
      timedOut: result.timedOut
    });

    let verdict = null;
    if (result.status === 0 && (await pathExists(verdictPath))) {
      verdict = JSON.parse(await fs.readFile(verdictPath, "utf8"));
    } else {
      hadFailures = true;
      verdict = syntheticVerdict(
        "RED",
        "Codex execution failed",
        `${result.stderr || result.stdout || "No response from Codex."}`,
        "runtime"
      );
    }

    await writeJson(path.join(reviewerDir, "verdict.json"), verdict);
    if (result.status === 0) {
      await writeText(path.join(reviewerDir, ".ready"), `${nowIso()}\n`);
    }
    for (const finding of verdict.findings || []) {
      await appendTraceability(repoRoot, feature, {
        type: "finding_promoted",
        scope,
        iteration,
        reviewer: `reviewer-${reviewerIndex}`,
        findingId: finding.id,
        route: inferFindingRoute(finding.artifact),
        artifact: finding.artifact
      });
    }
    const updatedJobs = await readJson(reviewerJobsPath(repoRoot, feature), []);
    const updatedJobIndex = updatedJobs.findIndex(
      (job) => job.scope === scope && job.iteration === iteration && job.reviewer === `reviewer-${reviewerIndex}`
    );
    if (updatedJobIndex >= 0) {
      updatedJobs[updatedJobIndex] = {
        ...updatedJobs[updatedJobIndex],
        status: result.status === 0 ? "completed" : "failed",
        completedAt: nowIso(),
        error: result.status === 0 ? null : result.stderr || result.stdout || "Codex execution failed",
        timedOut: result.status === 0 ? false : result.timedOut
      };
      await updateReviewerJobs(repoRoot, feature, updatedJobs);
    }
  }

  state.reviewIterations[scope] = iteration;
  await saveState(repoRoot, feature, state);
  await appendRunMetadata(repoRoot, feature, {
    command: scope === "plan" ? "plan-review" : "impl-review",
    kind: "model_invocation",
    status: hadFailures ? "failed" : "completed",
    provider: "openai-responses",
    requestedModel: String(options.model || "gpt-5.4"),
    resolvedModel: String(options.model || "gpt-5.4"),
    requestedEffort: "high",
    resolvedEffort: "high",
    detail: {
      feature,
      scope,
      iteration,
      reviewers,
      reviewTimeoutMs
    }
  });

  if (hadFailures) {
    throw new Error(`Codex review failed for ${scope}. See ${path.relative(repoRoot, iterationDir)}.`);
  }

  state.phase = scope === "plan" ? "plan_reviewed" : "impl_reviewed";
  await saveState(repoRoot, feature, state);
  return {
    feature,
    scope,
    iteration,
    reviewers
  };
}

function gatherOperationArtifacts(root, units) {
  return [
    ...units.map((unit) => path.join("operations", unit.id, "operations.json")),
    "apply-log.jsonl"
  ];
}

function gatherImplementationArtifacts(root, units) {
  return units.map((unit) => path.join("implementations", unit.id, "status.json"));
}

function reviewSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "verdict", "coverageComplete", "findings"],
    properties: {
      summary: { type: "string" },
      verdict: {
        type: "string",
        enum: ["GREEN", "YELLOW", "RED"]
      },
      coverageComplete: { type: "boolean" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "severity", "title", "detail", "artifact", "recommendation"],
          properties: {
            id: { type: "string" },
            severity: {
              type: "string",
              enum: ["low", "medium", "high", "critical"]
            },
            title: { type: "string" },
            detail: { type: "string" },
            artifact: { type: "string" },
            recommendation: { type: "string" }
          }
        }
      }
    }
  };
}

function syntheticVerdict(verdict, title, detail, artifact) {
  return {
    summary: title,
    verdict,
    coverageComplete: false,
    findings: [
      {
        id: `FIND-${sha256Text(`${title}:${detail}`).slice(0, 8)}`,
        severity: verdict === "RED" ? "high" : "medium",
        title,
        detail,
        artifact,
        recommendation: "Inspect the saved raw response and rerun the review."
      }
    ]
  };
}

export async function aggregateReviews(repoRoot, feature, scope) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, `aggregate:${scope}`);
  const root = featureRoot(repoRoot, feature);
  const iteration = state.reviewIterations[scope];
  if (!iteration) {
    throw new Error(`No ${scope} review iteration exists.`);
  }

  const iterationDir = path.join(root, "reviews", scope, `iteration-${iteration}`);
  const entries = await fs.readdir(iterationDir, { withFileTypes: true });
  const verdicts = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("reviewer-")) {
      continue;
    }

    const verdict = await readJson(path.join(iterationDir, entry.name, "verdict.json"));
    if (!verdict) {
      continue;
    }

    verdicts.push({
      reviewer: entry.name,
      ...verdict
    });
  }

  verdicts.sort((left, right) => left.reviewer.localeCompare(right.reviewer));

  const manifest = await readJson(path.join(iterationDir, "manifest.json"), null);
  const requiredArtifacts = manifest && Array.isArray(manifest.artifactsToReview)
    ? manifest.artifactsToReview.map((entry) =>
        typeof entry === "string" ? entry : entry?.path ?? ""
      ).filter(Boolean)
    : [];
  const manifestReviewerCount = manifest && Array.isArray(manifest.reviewers)
    ? manifest.reviewers.length
    : null;

  const aggregateCore = aggregateVerdictsCore(verdicts, {
    requiredArtifacts,
    manifestReviewerCount
  });

  const aggregate = {
    feature,
    scope,
    iteration,
    generatedAt: nowIso(),
    deterministic: true,
    reviewerCount: aggregateCore.reviewerCount,
    countedReviewerCount: aggregateCore.countedReviewerCount,
    verdict: aggregateCore.verdict,
    coverageComplete: aggregateCore.coverageComplete,
    counts: aggregateCore.counts,
    quorum: aggregateCore.quorum,
    findings: aggregateCore.findings
  };

  await writeJson(path.join(iterationDir, "aggregate.json"), aggregate);
  await ensureDir(path.join(root, "run-metadata", "aggregate"));
  await writeJson(path.join(root, "run-metadata", "aggregate", `${scope}-iteration-${iteration}.json`), {
    feature,
    scope,
    iteration,
    deterministic: true,
    verdict: aggregate.verdict,
    countedReviewerCount: aggregateCore.countedReviewerCount,
    generatedAt: aggregate.generatedAt
  });
  state.lastAggregate[scope] = aggregate.verdict;
  await saveState(repoRoot, feature, state);
  await appendRunMetadata(repoRoot, feature, {
    command: "aggregate",
    kind: "deterministic_execution",
    status: "completed",
    detail: {
      feature,
      scope,
      iteration,
      verdict: aggregate.verdict,
      countedReviewerCount: aggregateCore.countedReviewerCount
    }
  });
  return aggregate;
}

export async function recordApproval(repoRoot, feature, type, options = {}) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, `approve-${type}`);
  const root = featureRoot(repoRoot, feature);
  const scope = type === "plan" ? "plan" : "impl";
  const iteration = state.reviewIterations[scope];
  if (!iteration) {
    throw new Error(`${type} approval requires an aggregate-ready review iteration.`);
  }

  const manifestPath = path.join(root, "reviews", scope, `iteration-${iteration}`, "manifest.json");
  const aggregatePath = path.join(root, "reviews", scope, `iteration-${iteration}`, "aggregate.json");
  const aggregate = iteration
    ? await readJson(aggregatePath)
    : null;
  if (!aggregate) {
    throw new Error(`${type} approval requires aggregate.json.`);
  }

  const manifestHash = await hashFileIfExists(manifestPath);
  const aggregateHash = await hashFileIfExists(aggregatePath);
  const snapshotId = `${scope}-iteration-${iteration}`;

  if (options["manifest-hash"] && options["manifest-hash"] !== manifestHash) {
    throw new Error(`manifestHash mismatch for ${type} approval.`);
  }
  if (options["aggregate-hash"] && options["aggregate-hash"] !== aggregateHash) {
    throw new Error(`aggregateHash mismatch for ${type} approval.`);
  }
  if (options["snapshot-id"] && options["snapshot-id"] !== snapshotId) {
    throw new Error(`snapshotId mismatch for ${type} approval.`);
  }

  const entry = {
    approvalId: buildId("approval", `${feature}:${type}:${iteration}:${nowIso()}`),
    approvalKind: type === "plan" ? "plan_gate" : "impl_gate",
    phase: state.phase,
    iteration,
    snapshotId,
    manifestHash,
    aggregateHash,
    feature,
    type,
    approvedBy: options.by || "unknown",
    verdict: options.verdict || aggregate.verdict,
    reason: options.reason || options.notes || "",
    aggregateVerdict: aggregate.verdict,
    createdAt: nowIso()
  };

  await appendJsonl(path.join(root, "human-approvals.jsonl"), entry);

  if (type === "plan") {
    state.approvals.plan = true;
    state.phase = "plan_approved";
  } else {
    state.approvals.implementation = true;
    state.phase = aggregate?.verdict === "GREEN" ? "done" : "fix_required";
  }

  await writeText(
    path.join(root, "specs/convergence-checklist.md"),
    renderConvergenceChecklist(state, false)
  );
  await appendRunMetadata(repoRoot, feature, {
    command: type === "plan" ? "approve-plan" : "approve-impl",
    kind: "orchestration",
    status: "completed",
    detail: entry
  });
  await saveState(repoRoot, feature, state);
  return entry;
}

function resolveFindingUnit(units, finding) {
  const artifact = String(finding.artifact || "");
  const matches = units.filter((unit) =>
    unit.paths?.some((unitPath) => artifact.includes(unitPath))
  );

  if (matches.length === 1) {
    return matches[0].id;
  }

  return null;
}

function buildTemporaryUnit(clusterId, findings) {
  const artifactFiles = Array.from(
    new Set(
      findings
        .map((finding) => String(finding.artifact || ""))
        .filter((artifact) => artifact.includes("/") && !artifact.startsWith("reviews/"))
    )
  );
  const artifactDirs = Array.from(
    new Set(
      artifactFiles
        .map((artifact) => path.dirname(artifact))
        .filter((directory) => directory && directory !== ".")
        .map(normalizeScopePrefix)
    )
  );
  const unitId = slugify(`temporary-${clusterId}`);
  return {
    id: unitId,
    role: "fixer",
    paths: artifactFiles,
    dependsOn: [],
    scope: "orphan-fix",
    verificationTier: "tier0",
    writePaths: artifactDirs,
    writeFiles: artifactFiles,
    readPaths: artifactDirs,
    readFiles: artifactFiles,
    briefPath: `contexts/unit-${unitId}.md`,
    originClusterId: clusterId,
    findings
  };
}

export async function approveOrphanCluster(repoRoot, feature, options = {}) {
  const clusterId = options["cluster-id"] || options.clusterId;
  if (!clusterId) {
    throw new Error("approve-orphan requires --cluster-id");
  }

  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "approve-orphan");
  const root = featureRoot(repoRoot, feature);
  const resolutionPath = path.join(root, "fixes/orphan", clusterId, "resolution.json");
  const resolution = await readJson(resolutionPath);
  if (!resolution) {
    throw new Error(`Missing orphan resolution: ${clusterId}`);
  }

  const verdict = options.verdict || "approve";
  const approvalId = buildId("approval", `${feature}:orphan:${clusterId}:${nowIso()}`);
  const patchPath = path.join(root, "team-composition.patch.json");
  const existingPatch = (await readJson(patchPath)) || {
    schemaVersion: 1,
    feature,
    createdAt: nowIso(),
    reason: "temporary_orphan_unit",
    approvalRef: approvalId,
    temporaryUnits: []
  };

  const entry = {
    approvalId,
    approvalKind: "temporary_orphan_unit",
    phase: state.phase,
    iteration: state.reviewIterations.impl,
    snapshotId: `impl-iteration-${state.reviewIterations.impl || 0}`,
    manifestHash: await hashFileIfExists(
      path.join(root, "reviews/impl", `iteration-${state.reviewIterations.impl || 0}`, "manifest.json")
    ),
    aggregateHash: await hashFileIfExists(
      path.join(root, "reviews/impl", `iteration-${state.reviewIterations.impl || 0}`, "aggregate.json")
    ),
    feature,
    clusterId,
    approvedBy: options.by || "unknown",
    verdict,
    reason: options.reason || "",
    createdAt: nowIso()
  };

  if (verdict === "approve") {
    const temporaryUnit = resolution.temporaryUnit || buildTemporaryUnit(clusterId, resolution.findings || []);
    const filtered = existingPatch.temporaryUnits.filter((unit) => unit.id !== temporaryUnit.id);
    existingPatch.approvalRef = approvalId;
    existingPatch.temporaryUnits = [...filtered, temporaryUnit];
    await writeJson(patchPath, existingPatch);
    await writeText(
      path.join(root, temporaryUnit.briefPath),
      [
        `# Unit ${temporaryUnit.id}`,
        "",
        "Role: fixer",
        "",
        "Temporary orphan unit approved by human gate.",
        "",
        `Origin cluster: ${clusterId}`,
        `Paths: ${(temporaryUnit.writeFiles || []).join(", ") || "(none provided)"}`,
        "",
        "Findings:",
        ...(resolution.findings || []).map((finding) => `- ${finding.id}: ${finding.title}`)
      ].join("\n")
    );
    resolution.status = "approved";
    resolution.approvalRef = approvalId;
  } else {
    resolution.status = verdict === "reject" ? "rejected" : "replan_required";
  }

  await writeJson(resolutionPath, resolution);
  await appendJsonl(path.join(root, "human-approvals.jsonl"), entry);
  await appendRunMetadata(repoRoot, feature, {
    command: "approve-orphan",
    kind: "orchestration",
    status: "completed",
    detail: entry
  });

  if (verdict === "replan_required") {
    state.phase = "planned";
    await saveState(repoRoot, feature, state);
  }

  return entry;
}

export async function prepareFixes(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  ensureCommandEntryPhase(state, "fix");
  const root = featureRoot(repoRoot, feature);
  const teamComposition = await loadEffectiveTeamComposition(repoRoot, feature);
  const iteration = state.reviewIterations.impl;
  if (!iteration) {
    throw new Error("No implementation review exists.");
  }

  const aggregate = await readJson(path.join(root, "reviews/impl", `iteration-${iteration}`, "aggregate.json"));
  if (!aggregate) {
    throw new Error("Implementation aggregate is missing.");
  }

  const grouped = new Map();
  const actionableFindings = aggregate.findings.filter(
    (finding) => inferFindingRoute(finding.artifact) !== "review_meta"
  );
  for (const finding of actionableFindings) {
    const unitId = resolveFindingUnit(teamComposition.units, finding);
    const key = unitId || `fixer-orphan-${slugify(finding.id || finding.title || "general")}`;
    const current = grouped.get(key) || [];
    current.push(finding);
    grouped.set(key, current);
    await appendTraceability(repoRoot, feature, {
      type: "finding_routed",
      findingId: finding.id,
      route: unitId ? "existing_unit" : "orphan",
      clusterId: key
    });
  }

  for (const [clusterId, findings] of grouped.entries()) {
    const orphan = clusterId.startsWith("fixer-orphan-");
    const resolutionPath = path.join(root, "fixes/orphan", clusterId, "resolution.json");
    const existingResolution = await readJson(resolutionPath);
    await writeJson(resolutionPath, {
      clusterId,
      generatedAt: nowIso(),
      status:
        existingResolution?.status && ["approved", "resolved", "rejected", "replan_required"].includes(existingResolution.status)
          ? existingResolution.status
          : orphan
            ? "needs_approval"
            : "pending",
      resolutionKind: orphan ? "temporary_orphan_unit" : "existing_unit",
      temporaryUnit:
        existingResolution?.temporaryUnit || (orphan ? buildTemporaryUnit(clusterId, findings) : null),
      approvalRef: existingResolution?.approvalRef || null,
      findings
    });
  }

  await appendJsonl(path.join(root, "fix-log.jsonl"), {
    ts: nowIso(),
    feature,
    clusterCount: grouped.size
  });
  await appendRunMetadata(repoRoot, feature, {
    command: "fix",
    kind: "model_invocation",
    status: "completed",
    detail: {
      feature,
      clusterCount: grouped.size,
      actionableFindingCount: actionableFindings.length
    }
  });

  state.phase = "fix_required";
  await saveState(repoRoot, feature, state);
  return {
    feature,
    clusterCount: grouped.size
  };
}

function makeFixAgents(teamComposition, resolutions) {
  const agents = {};

  for (const resolution of resolutions) {
    const unit =
      teamComposition.units.find((candidate) => candidate.id === resolution.clusterId) ||
      teamComposition.units.find(
        (candidate) => candidate.originClusterId && candidate.originClusterId === resolution.clusterId
      );
    const agentId = unit?.id || resolution.clusterId;
    const writable = (unit?.writeFiles?.length ? unit.writeFiles : unit?.writePaths || []).join(", ") || "(unspecified)";
    agents[agentId] = {
      description: `Fix cluster ${resolution.clusterId} within ${writable}.`,
      prompt: [
        `Address fix cluster ${resolution.clusterId}.`,
        `Touch only: ${writable}.`,
        "Resolve the findings below and keep the workspace test suite green.",
        "",
        ...(resolution.findings || []).map(
          (finding) => `- ${finding.id} [${finding.severity}] ${finding.title}: ${finding.detail}`
        )
      ].join("\n")
    };
  }

  return agents;
}

async function loadFixResolutions(root) {
  const orphanRoot = path.join(root, "fixes/orphan");
  if (!(await pathExists(orphanRoot))) {
    return [];
  }

  const entries = await fs.readdir(orphanRoot, { withFileTypes: true });
  const resolutions = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const resolution = await readJson(path.join(orphanRoot, entry.name, "resolution.json"));
    if (resolution) {
      resolutions.push(resolution);
    }
  }

  return resolutions.sort((left, right) => left.clusterId.localeCompare(right.clusterId));
}

export async function runFixWorkflow(repoRoot, feature) {
  const prep = await prepareFixes(repoRoot, feature);
  const root = featureRoot(repoRoot, feature);
  const resolutions = await loadFixResolutions(root);
  const blocked = resolutions.filter((resolution) => resolution.status === "needs_approval");
  if (blocked.length > 0) {
    throw new Error(`Fix workflow is blocked by orphan approvals: ${blocked.map((item) => item.clusterId).join(", ")}`);
  }
  if (prep.clusterCount === 0) {
    return {
      feature,
      clusterCount: 0,
      status: "no_actionable_findings"
    };
  }

  try {
    ensureAgentTeamsPreflight(repoRoot);
    ensureClaudePreflight(repoRoot);
  } catch (error) {
    await appendRunMetadata(repoRoot, feature, {
      command: "fix",
      kind: "model_invocation",
      status: "rejected",
      policyDecision: "deny",
      policyReason: error.message,
      detail: {
        feature,
        clusterCount: prep.clusterCount
      }
    });
    throw error;
  }

  const teamComposition = await loadEffectiveTeamComposition(repoRoot, feature);
  const repoDir = path.join(root, "workspace/repo");
  const agents = makeFixAgents(
    teamComposition,
    resolutions.filter((resolution) => ["pending", "approved"].includes(resolution.status))
  );
  const schemaPath = path.join(root, "team-runtime/claude-fix-schema.json");
  const responsePath = path.join(root, "team-runtime/claude-fix-last-message.json");
  const rawPath = path.join(root, "team-runtime/claude-fix-raw-response.json");
  const prompt = [
    "You are fixing review findings in a sample Node.js repository workspace.",
    "Use the available agent capability to delegate work to the provided fix agents before finishing.",
    "Modify only the workspace repo.",
    "Run `npm test` before you finish.",
    "",
    "Return JSON matching the schema."
  ].join("\n");
  const promptPayloadHash = sha256Text(prompt);

  await writeJson(schemaPath, {
    type: "object",
    additionalProperties: false,
    required: ["summary", "delegatedAgents", "resolvedClusters", "changedFiles", "testsPassed"],
    properties: {
      summary: { type: "string" },
      delegatedAgents: {
        type: "array",
        items: { type: "string" }
      },
      resolvedClusters: {
        type: "array",
        items: { type: "string" }
      },
      changedFiles: {
        type: "array",
        items: { type: "string" }
      },
      testsPassed: { type: "boolean" }
    }
  });

  await appendJsonl(path.join(root, "team-runtime/task-ledger.jsonl"), {
    ts: nowIso(),
    phase: "fix_required",
    event: "claude_fix_started",
    agents: Object.keys(agents)
  });

  const result = runProcess(
    "claude",
    [
      "-p",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--json-schema",
      await fs.realpath(schemaPath),
      "--agents",
      JSON.stringify(agents),
      "-"
    ],
    {
      cwd: repoDir,
      input: prompt,
      env: {
        ...process.env,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"
      },
      timeoutMs: Number(process.env.MAVSDD_IMPLEMENT_TIMEOUT_MS) || 15 * 60 * 1000
    }
  );

  await writeJson(rawPath, {
    command: "claude",
    args: ["-p", "--model", "sonnet", "--agents", agents],
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    promptPayloadHash
  });

  let parsed = null;
  try {
    parsed = JSON.parse(extractClaudeJson(result.stdout));
    await writeJson(responsePath, parsed);
  } catch (error) {
    throw new Error(`Failed to parse Claude fix response: ${error.message}`);
  }

  if (result.status !== 0 || !parsed.testsPassed) {
    await appendRunMetadata(repoRoot, feature, {
      command: "fix",
      kind: "model_invocation",
      status: "failed",
      provider: "anthropic",
      requestedModel: "sonnet",
      resolvedModel: "sonnet",
      requestedEffort: "high",
      resolvedEffort: "high",
      promptPayloadHash,
      detail: {
        feature,
        stderr: result.stderr,
        stdout: result.stdout
      }
    });
    throw new Error(`Claude fix failed: ${result.stderr || result.stdout}`);
  }

  for (const resolution of resolutions) {
    if (parsed.resolvedClusters.includes(resolution.clusterId)) {
      resolution.status = "resolved";
      resolution.resolvedAt = nowIso();
      await writeJson(path.join(root, "fixes/orphan", resolution.clusterId, "resolution.json"), resolution);
    }
  }

  const state = await loadState(repoRoot, feature);
  state.phase = "implemented";
  await saveState(repoRoot, feature, state);
  await appendJsonl(path.join(root, "team-runtime/task-ledger.jsonl"), {
    ts: nowIso(),
    phase: "implemented",
    event: "claude_fix_finished",
    summary: parsed.summary,
    delegatedAgents: parsed.delegatedAgents,
    resolvedClusters: parsed.resolvedClusters
  });
  await appendRunMetadata(repoRoot, feature, {
    command: "fix",
    kind: "model_invocation",
    status: "completed",
    provider: "anthropic",
    requestedModel: "sonnet",
    resolvedModel: "sonnet",
    requestedEffort: "high",
    resolvedEffort: "high",
    promptPayloadHash,
    detail: {
      feature,
      resolvedClusters: parsed.resolvedClusters,
      changedFiles: parsed.changedFiles
    }
  });

  return parsed;
}

export async function statusSummary(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  const reviewerJobs = await readJson(reviewerJobsPath(repoRoot, feature), []);
  return {
    feature: state.feature,
    phase: state.phase,
    targetRepo: state.targetRepoRelative,
    verifyCommand: state.verifyCommand,
    approvals: state.approvals,
    reviewIterations: state.reviewIterations,
    lastAggregate: state.lastAggregate,
    reviewerJobs,
    external: await detectExternalStatus(repoRoot)
  };
}

export async function resumeSummary(repoRoot, feature) {
  const state = await loadState(repoRoot, feature);
  const reviewerJobs = await readJson(reviewerJobsPath(repoRoot, feature), []);
  const relevantScope = currentReviewScopeForPhase(state);
  const relevantIteration = relevantScope ? state.reviewIterations[relevantScope] || 0 : 0;
  const pendingJobs = reviewerJobs.filter((job) => {
    if (job.status === "completed") {
      return false;
    }
    if (!relevantScope) {
      return false;
    }
    if (job.scope !== relevantScope) {
      return false;
    }
    if (relevantIteration > 0 && job.iteration !== relevantIteration) {
      return false;
    }
    return true;
  });
  const blockedBy = [];
  const nextCommand =
    pendingJobs.length > 0
      ? `node scripts/cli/mavsdd.mjs ${pendingJobs[0].scope === "plan" ? "plan-review" : "impl-review"} --feature ${feature} --reviewers ${pendingJobs.length}`
      : nextCommandForPhase(state.phase, feature);
  if (
    nextCommand.includes("mavsdd.mjs implement") ||
    nextCommand.includes("mavsdd.mjs fix") ||
    nextCommand.startsWith("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1")
  ) {
    try {
      ensureAgentTeamsPreflight(repoRoot);
      ensureClaudePreflight(repoRoot);
    } catch (error) {
      blockedBy.push(error.message);
    }
  }
  if (nextCommand.includes("plan-review") || nextCommand.includes("impl-review")) {
    try {
      ensureCodexPreflight(repoRoot);
    } catch (error) {
      blockedBy.push(error.message);
    }
  }
  return {
    feature,
    phase: state.phase,
    nextCommand,
    pendingReviewers: pendingJobs,
    blockedBy
  };
}

function nextCommandForPhase(phase, feature) {
  const commands = {
    initialized: `node scripts/cli/mavsdd.mjs plan --feature ${feature}`,
    planned: `node scripts/cli/mavsdd.mjs plan-review --feature ${feature}`,
    plan_reviewed: `node scripts/cli/mavsdd.mjs aggregate --feature ${feature} --scope plan`,
    plan_approved: `node scripts/cli/mavsdd.mjs red --feature ${feature}`,
    red: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 node scripts/cli/mavsdd.mjs implement --feature ${feature}`,
    implemented: `node scripts/cli/mavsdd.mjs stage --feature ${feature}`,
    staged: `node scripts/cli/mavsdd.mjs apply --feature ${feature}`,
    applied: `node scripts/cli/mavsdd.mjs verify --feature ${feature}`,
    verified: `node scripts/cli/mavsdd.mjs impl-review --feature ${feature}`,
    impl_reviewed: `node scripts/cli/mavsdd.mjs aggregate --feature ${feature} --scope impl`,
    fix_required: `node scripts/cli/mavsdd.mjs fix --feature ${feature}`,
    done: "Feature complete."
  };

  return commands[phase] || `node scripts/cli/mavsdd.mjs status --feature ${feature}`;
}

async function applySingleOperation(state, op, operation) {
  const resolveLive = (relativePath) => path.join(state.targetRepo, relativePath);
  const ensureHashMatches = async (relativePath, expectedHash) => {
    const livePath = resolveLive(relativePath);
    const currentContent = (await pathExists(livePath))
      ? await fs.readFile(livePath, "utf8")
      : null;
    const currentHash = currentContent === null ? null : sha256Text(currentContent);
    if (currentHash !== (expectedHash ?? null)) {
      throw new Error(
        `Base hash mismatch for ${relativePath}: expected ${expectedHash}, got ${currentHash}`
      );
    }
  };

  if (op === OP_DELETE) {
    await ensureHashMatches(operation.path, operation.baseHash);
    const livePath = resolveLive(operation.path);
    if (await pathExists(livePath)) {
      await fs.rm(livePath);
    }
    return 1;
  }

  if (op === OP_RENAME) {
    await ensureHashMatches(operation.from, operation.baseHash);
    const liveFrom = resolveLive(operation.from);
    const liveTo = resolveLive(operation.to);
    await ensureDir(path.dirname(liveTo));
    if (operation.newContent && operation.newContent.length > 0) {
      await fs.writeFile(liveTo, operation.newContent);
      if (await pathExists(liveFrom)) {
        await fs.rm(liveFrom);
      }
    } else {
      if (await pathExists(liveFrom)) {
        await fs.rename(liveFrom, liveTo);
      }
    }
    if (operation.mode != null) {
      await fs.chmod(liveTo, operation.mode);
    }
    return 1;
  }

  if (op === OP_CHMOD) {
    await ensureHashMatches(operation.path, operation.baseHash);
    if (operation.mode == null) {
      throw new Error(`chmod operation for ${operation.path} is missing mode`);
    }
    await fs.chmod(resolveLive(operation.path), operation.mode);
    return 1;
  }

  // add / overwrite
  await ensureHashMatches(operation.path, operation.baseHash);
  const livePath = resolveLive(operation.path);
  await ensureDir(path.dirname(livePath));
  await fs.writeFile(livePath, operation.newContent ?? "");
  if (operation.mode != null) {
    await fs.chmod(livePath, operation.mode);
  }
  return 1;
}

async function buildFileManifest(baseDir) {
  const manifest = {};
  await walkFiles(baseDir, async (absolutePath, relativePath) => {
    const content = await fs.readFile(absolutePath, "utf8");
    const stats = await fs.lstat(absolutePath);
    const sha = sha256Text(content);
    manifest[relativePath] = {
      sha256: sha,
      hash: `sha256:${sha}`,
      bytes: Buffer.byteLength(content),
      mode: stats.mode & 0o777
    };
  });
  return manifest;
}

function detectRepoHead(targetRepo) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: targetRepo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim() || null;
    }
  } catch {}
  return null;
}

async function walkFiles(root, callback, prefix = "") {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    const absolutePath = path.join(root, relativePath);

    if (entry.isDirectory()) {
      await walkFiles(root, callback, relativePath);
      continue;
    }

    await callback(absolutePath, relativePath);
  }
}

function runShellCommand(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

export function runProcess(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  };
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    spawnOptions.timeout = options.timeoutMs;
    spawnOptions.killSignal = "SIGTERM";
  }
  const result = spawnSync(command, args, spawnOptions);

  const timedOut = Boolean(
    result.error && (result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM")
  );
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout || "",
    stderr: result.stderr || (timedOut ? `process timed out after ${options.timeoutMs}ms` : ""),
    timedOut
  };
}
