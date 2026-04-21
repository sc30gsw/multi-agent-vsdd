#!/usr/bin/env bash
# mavsdd installer — guides the user through enabling Multi-Agent VSDD in their
# Claude Code environment. Idempotent; safe to run multiple times.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HERE/.claude-plugin/plugin.json','utf8')).name)")"

log() {
  printf "[mavsdd] %s\n" "$*"
}

die() {
  printf "[mavsdd] ERROR: %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

validate_plugin() {
  if command -v claude >/dev/null 2>&1; then
    log "validating plugin manifest"
    claude plugins validate "$HERE"
  else
    log "skipping claude plugins validate (claude CLI not found)"
  fi
}

check_agent_teams_flag() {
  if [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-0}" != "1" ]; then
    cat <<'EOF'

[mavsdd] NOTE: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is not set to 1.
         The /mavsdd-implement and /mavsdd-fix skills rely on Agent Teams.
         Add this to your shell rc (and restart the Claude Code session):

           export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

EOF
  else
    log "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 — Agent Teams enabled."
  fi
}

check_codex_cli() {
  if command -v codex >/dev/null 2>&1; then
    log "codex CLI detected — adversarial review path is available"
  else
    cat <<'EOF'

[mavsdd] NOTE: codex CLI not found on PATH.
         /mavsdd-plan-review and /mavsdd-impl-review require `codex`.
         Install via https://github.com/openai/codex-cli and run `codex login`.

EOF
  fi
}

print_next_steps() {
  cat <<EOF

[mavsdd] Plugin directory: $HERE
[mavsdd] Plugin name:      $PLUGIN_NAME

Next steps:

  1. Make sure CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 is exported (see above).
  2. In Claude Code: /plugin, then install this directory or add it to a marketplace.
  3. Smoke test the CLI:

       node $HERE/scripts/cli/mavsdd.mjs status --feature sample-e2e

  4. Start a new feature:

       /mavsdd-init <feature-name>
       /mavsdd-plan "<one-sentence goal>"

  The threat model (README.md §Threat Model) is important reading before
  running /mavsdd-apply on a repo you care about.
EOF
}

main() {
  require_cmd node
  validate_plugin
  check_agent_teams_flag
  check_codex_cli
  print_next_steps
}

main "$@"
