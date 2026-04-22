---
name: mavsdd-approve-plan
description: Record the human approval gate for the current feature plan.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs approve-plan*)
---

# mavsdd-approve-plan

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" approve-plan \
  --feature <feature-name> \
  --by "<your-name>"
```
