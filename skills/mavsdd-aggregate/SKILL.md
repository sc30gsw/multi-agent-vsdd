---
name: mavsdd-aggregate
description: Aggregate deterministic plan or implementation review verdicts into a single aggregate.json artifact.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs aggregate*)
---

# mavsdd-aggregate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" aggregate \
  --feature <feature-name> --scope plan
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" aggregate \
  --feature <feature-name> --scope impl
```
