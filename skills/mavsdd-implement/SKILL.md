---
name: mavsdd-implement
description: Materialize workspace copies and run Claude Code implementation with Agent Teams preflight guards.
disable-model-invocation: true
allowed-tools: Bash(node scripts/cli/mavsdd.mjs implement*)
---

# mavsdd-implement

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `claude auth login` are required.

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 node scripts/cli/mavsdd.mjs implement --feature <feature-name>
```
