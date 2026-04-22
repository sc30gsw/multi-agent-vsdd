---
name: mavsdd-fix
description: Cluster implementation review findings, enforce orphan approval, and run the Claude fixer team against workspace/repo.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs fix*)
---

# mavsdd-fix

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `claude auth login` are required.

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" fix \
  --feature <feature-name>
```
