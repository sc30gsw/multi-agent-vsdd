---
name: mavsdd-init
description: Initialize a disk-first Multi-Agent VSDD feature workspace under .mavsdd/ for a target repository.
disable-model-invocation: true
allowed-tools: Bash(node scripts/cli/mavsdd.mjs init*)
---

# mavsdd-init

Run the trusted CLI from the repo root:

```bash
node scripts/cli/mavsdd.mjs init --feature <feature-name> --target <repo-path> --verify-command "npm test"
```
