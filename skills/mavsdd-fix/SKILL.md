---
name: mavsdd-fix
description: Cluster implementation review findings, enforce orphan approval, and run the Claude fixer team against workspace/repo.
disable-model-invocation: true
allowed-tools: Bash(node scripts/cli/mavsdd.mjs fix*)
---

# mavsdd-fix

```bash
node scripts/cli/mavsdd.mjs fix --feature <feature-name>
```
