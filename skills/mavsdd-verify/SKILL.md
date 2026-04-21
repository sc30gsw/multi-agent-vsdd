---
name: mavsdd-verify
description: Execute the configured verification command against the live target repo and persist evidence under verification/.
disable-model-invocation: true
allowed-tools: Bash(node scripts/cli/mavsdd.mjs verify*)
---

# mavsdd-verify

```bash
node scripts/cli/mavsdd.mjs verify --feature <feature-name>
```
