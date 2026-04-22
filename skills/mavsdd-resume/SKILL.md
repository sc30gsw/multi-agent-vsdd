---
name: mavsdd-resume
description: Suggest the next trusted CLI command based on the persisted phase under .mavsdd/.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs resume*)
---

# mavsdd-resume

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" resume --feature <feature-name>
```
