---
name: mavsdd-plan-review
description: Run adversarial plan review. Backends (plan §0.3) — codex (default Codex gpt-5.4 jury) | claude (Claude Opus 4.7 xhigh real reviewer) | mock (human-signed dummy, audit preserved).
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs plan-review*)
---

# mavsdd-plan-review

Default: **3 reviewers, Codex `gpt-5.4` adversarial review** (plan §0.2 / §0.5).

Three backends (plan §0.3):

- **`codex`** (default) — Codex adversarial jury. Requires `codex login`.
- **`claude`** — **Claude Opus 4.7 xhigh real reviewer** (spawns `claude -p --model opus --agents '{mavsdd-reviewer}'` N times). Use when Codex is unavailable or when an in-house second opinion is wanted.
- **`mock`** — human-signed dummy verdict with `meta.source: "human-mock"`. Only when the operator intentionally skips review (audit trail preserved).

```bash
# Default: 3-reviewer Codex adversarial review
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" plan-review \
  --feature <feature-name>

# Claude Opus 4.7 xhigh (Codex unavailable, or in-house second opinion)
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" plan-review \
  --feature <feature-name> --reviewers 3 --backend claude

# Mock (review intentionally skipped — last resort)
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" plan-review \
  --feature <feature-name> --reviewers 3 \
  --backend mock --verdict GREEN \
  --reason "intentional skip: reviewer unavailable" --by "<name>"
```

Output written to `.mavsdd/features/<feature>/reviews/plan/iteration-<K>/reviewer-<N>/verdict.json`. `raw-response.json` captures the model's stdout/stderr for audit. Phase transitions to `plan_reviewed` in all backends.
