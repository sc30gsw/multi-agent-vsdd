---
name: mavsdd-impl-review
description: Run adversarial review (Codex jury by default, human-mock fallback) for implementation artifacts and persist verdicts.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs impl-review*)
---

# mavsdd-impl-review

Default: **3 reviewers, Codex `gpt-5.4` adversarial review** (plan §0.2 / §0.5). Drop to `--reviewers 1` only for demos. Use `--backend mock` when Codex is unavailable.

```bash
# Default: 3-reviewer Codex adversarial review
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" impl-review \
  --feature <feature-name>

# Explicit reviewer count
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" impl-review \
  --feature <feature-name> --reviewers 3

# Codex unavailable — inject human-mock verdicts
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" impl-review \
  --feature <feature-name> --reviewers 3 \
  --backend mock --verdict GREEN \
  --reason "Codex quota exhausted 2026-04-22" --by "<your-name>"
```

Backends and output layout: identical to `/mavsdd-plan-review`, but scope is `impl` and the iteration dir is `reviews/impl/iteration-<K>/`. Phase transitions to `impl_reviewed`.
