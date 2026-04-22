---
name: mavsdd-approve-orphan
description: Record the human gate for a temporary orphan fix cluster and emit team-composition.patch.json when approved.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs approve-orphan*)
---

# mavsdd-approve-orphan

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli/mavsdd.mjs" approve-orphan \
  --feature <feature-name> \
  --cluster-id <cluster-id> \
  --verdict approve \
  --by "<your-name>"
```
