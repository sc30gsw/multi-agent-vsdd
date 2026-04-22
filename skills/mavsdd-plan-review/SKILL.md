---
name: mavsdd-plan-review
description: Run adversarial review (Codex jury by default, human-mock fallback) for plan artifacts and persist verdicts.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs plan-review*)
---

# mavsdd-plan-review

Default: **3 reviewers, Codex `gpt-5.4` adversarial review** (plan §0.2 / §0.5). Drop to `--reviewers 1` only for demos. Use `--backend mock` when Codex is unavailable — a human-mock verdict is injected with full audit metadata (`meta.source="human-mock"`, `meta.reason`, `meta.reviewedBy`).

```bash
# Default: 3-reviewer Codex adversarial review
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" plan-review \
  --feature <feature-name>

# Explicit reviewer count
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" plan-review \
  --feature <feature-name> --reviewers 3

# Codex unavailable — inject human-mock verdicts (audit trail preserved)
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" plan-review \
  --feature <feature-name> --reviewers 3 \
  --backend mock --verdict GREEN \
  --reason "Codex quota exhausted 2026-04-22" --by "<your-name>"
```

Backends:

- `codex` (default) — `codex exec --model gpt-5.4 --sandbox read-only`. Requires `codex login`.
- `mock` — synthesize N verdicts with `meta.source: "human-mock"`. Use `--verdict GREEN|YELLOW|RED` (default GREEN). Preferred over hand-writing `verdict.json` — keeps `run-metadata/events.jsonl` consistent.

Output written to `.mavsdd/features/<feature>/reviews/plan/iteration-<K>/reviewer-<N>/verdict.json`. Phase transitions to `plan_reviewed` in both backends.
