---
name: mavsdd-apply
description: Apply staged operations to the live target repo with base-hash verification and apply-lock protection.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs apply*)
---

# mavsdd-apply

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" apply --feature <feature-name>
```
