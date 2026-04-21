# spike-team-create

## Goal

Claude Code Agent Teams を trusted CLI から使う前提を固定する。

## Observed Local State

- `claude --version`: `2.1.116`
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`: unset by default
- `claude auth status`: `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}`

## Chosen Invocation Surface

v1 では public automation surface を次に固定する。

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
claude -p \
  --model sonnet \
  --permission-mode bypassPermissions \
  --output-format json \
  --json-schema <schema-path> \
  --agents '<json>' \
  -
```

trusted CLI はこの surface を使って current workspace repo 上で実装を行う。`implement` は preflight で以下を強制する。

- Claude Code `v2.1.32+`
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- `claude auth status` が `loggedIn: true`

## Current Blocker

この environment では `claude auth login` 未実施のため、実接続 verification は fail-closed になる。
