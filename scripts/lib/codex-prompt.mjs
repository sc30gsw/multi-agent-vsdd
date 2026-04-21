// Codex prompt module: reviewer prompt construction and adapter to
// Task(codex:codex-rescue). Concrete bodies live in mavsdd-core.mjs; this
// shim is the plan-compliant import surface.

export {
  runReview,
  runClaudeImplementation
} from "./mavsdd-core.mjs";
