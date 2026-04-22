---
name: mavsdd-impl-review
description: Run adversarial implementation review. Backends (plan §0.3) — codex (default Codex gpt-5.4 jury) | claude (Claude Opus 4.7 xhigh real reviewer) | mock (human-signed dummy, audit preserved).
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs impl-review*)
---

# mavsdd-impl-review

Default: **3 reviewers, Codex `gpt-5.4` adversarial review** (plan §0.2 / §0.5).

```bash
# Default: 3-reviewer Codex adversarial review
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" impl-review \
  --feature <feature-name>

# Claude Opus 4.7 xhigh (Codex unavailable, or in-house second opinion)
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" impl-review \
  --feature <feature-name> --reviewers 3 --backend claude

# Mock (review intentionally skipped — last resort)
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" impl-review \
  --feature <feature-name> --reviewers 3 \
  --backend mock --verdict GREEN \
  --reason "intentional skip" --by "<name>"
```

Backends and output layout: identical to `/mavsdd-plan-review`, but scope is `impl` and the iteration dir is `reviews/impl/iteration-<K>/`. Phase transitions to `impl_reviewed`.
