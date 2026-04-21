// Workspace module: materialization, baseline manifest, and tier-aware
// verification. Concrete bodies live in mavsdd-core.mjs; this shim gives the
// plan-compliant module layout a stable import surface.

export {
  materializeWorkspaces,
  runVerification
} from "./mavsdd-core.mjs";
