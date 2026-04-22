---
name: mavsdd-red
description: Freeze the requested behavior into red-phase test artifacts before implementation starts.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs red*)
---

# mavsdd-red

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" red --feature <feature-name>
```
