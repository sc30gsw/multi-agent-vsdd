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
  if ! command -v claude >/dev/null 2>&1; then
    log "skipping plugin validate (claude CLI not found)"
    return 0
  fi
  log "validating plugin and marketplace manifests"
  if claude plugin validate "$HERE" 2>/dev/null; then
    return 0
  fi
  log "claude plugin validate failed; retrying with legacy 'claude plugins validate'"
  claude plugins validate "$HERE"
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
[mavsdd] Marketplace name: mavsdd

Next steps:

  1. Make sure CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 is exported (see above).

  2. Install via the bundled marketplace (recommended):

       In Claude Code:
         /plugin marketplace add $HERE
         /plugin install multi-agent-vsdd@mavsdd

       Or against the published GitHub repo:
         /plugin marketplace add sc30gsw/multi-agent-vsdd
         /plugin install multi-agent-vsdd@mavsdd

     Restart the Claude Code session after install so SessionStart hooks load.

  3. Smoke test the CLI directly (works in any cwd):

       node "$HERE/scripts/cli/mavsdd.mjs" status --feature sample-feature

  4. Start a new feature (cd to your target repo first):

       /mavsdd-init    # SKILL body uses \${CLAUDE_PLUGIN_ROOT}
       /mavsdd-plan

  The Threat Model section of README.md is important reading before
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
