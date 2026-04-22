---
name: mavsdd-impl-review
description: Run Codex jury review for implementation artifacts, verification evidence, and staged operations.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs impl-review*)
---

# mavsdd-impl-review

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" impl-review \
  --feature <feature-name> \
  --reviewers 1
```
