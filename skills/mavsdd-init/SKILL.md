---
name: mavsdd-init
description: Initialize a disk-first Multi-Agent VSDD feature workspace under .mavsdd/ for a target repository.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs init*)
---

# mavsdd-init

Run from the directory where `.mavsdd/` should live (typically the user's target repo root):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" init \
  --feature <feature-name> \
  --target <repo-path> \
  --verify-command "npm test"
```
