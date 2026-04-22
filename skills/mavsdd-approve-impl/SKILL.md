---
name: mavsdd-approve-impl
description: Record the human implementation approval gate and close the feature when the aggregate verdict is green.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs approve-impl*)
---

# mavsdd-approve-impl

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" approve-impl \
  --feature <feature-name> \
  --by "<your-name>"
```
