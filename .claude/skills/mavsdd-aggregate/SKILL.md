---
name: mavsdd-aggregate
description: Aggregate deterministic plan or implementation review verdicts into a single aggregate.json artifact.
disable-model-invocation: true
allowed-tools: Bash(node scripts/cli/mavsdd.mjs aggregate*)
---

# mavsdd-aggregate

```bash
node scripts/cli/mavsdd.mjs aggregate --feature <feature-name> --scope plan
node scripts/cli/mavsdd.mjs aggregate --feature <feature-name> --scope impl
```
