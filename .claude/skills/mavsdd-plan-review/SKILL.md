---
name: mavsdd-plan-review
description: Run Codex jury review for plan artifacts and persist prompt payload, digests, raw responses, and verdicts.
disable-model-invocation: true
allowed-tools: Bash(node scripts/cli/mavsdd.mjs plan-review*)
---

# mavsdd-plan-review

```bash
node scripts/cli/mavsdd.mjs plan-review --feature <feature-name> --reviewers 1
```
