---
name: mavsdd-status
description: Print the active feature status, current phase, review iterations, approvals, and external preflight state.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs status*)
---

# mavsdd-status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" status --feature <feature-name>
```
