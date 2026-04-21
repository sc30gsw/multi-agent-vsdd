// State module: canonical wrappers around feature-state.json.
// The concrete implementations currently live in mavsdd-core.mjs and are
// re-exported here so the plan-compliant module layout is visible.
// A future refactor will move the bodies here (see plan §22 / C10).

export {
  PHASES,
  repoMavsddRoot,
  featureRoot,
  statePath,
  createFeatureState,
  loadState,
  saveState
} from "./mavsdd-core.mjs";
