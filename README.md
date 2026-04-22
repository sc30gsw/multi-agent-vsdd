# multi-agent-vsdd

Claude Code の Agent Teams と Codex CLI を組み合わせ、計画 → レビュー → 実装 → 検証までを **再開可能な disk-first ワークフロー** として回す Claude Code plugin です。すべての成果物（plan / review / workspace / verification / metadata）は `.mavsdd/` 配下に正本として残り、いつでも `/mavsdd-status` / `/mavsdd-resume` で続きから再開できます。

## できること

- **Plan** — Opus planner（`effort: xhigh`）が goal を 1〜5 unit に分解し、`plan.md` / `team-composition.json` / `contexts/unit-*.md` を生成
- **Plan Review** — Codex jury が独立に plan を採点し、verdict / digest / raw response を `.mavsdd/.../reviews/plan/` に保存
- **Implement** — Sonnet implementer team が `workspace/runtime/` 上で実装。`config/roles.json` の `allowedWritePaths` を超える書き込みは hook が fail-closed で拒否
- **Apply** — `MAVSDD_APPLY_TOKEN` + `.apply-lock` で隔離された apply subprocess が、operations manifest の `baseHash` を再検証してから本体 repo に反映
- **Verify / Fix** — `verify-command`（既定で `npm test`）を回し、失敗したら Codex impl-review → 修正クラスタ → fixer team のループで詰める
- **Auditability** — 全 model 実行は `.mavsdd/features/<feature>/run-metadata/events.jsonl` に append-only で記録

## Quick Start

### 1. 前提

| 要件 | 確認 |
|---|---|
| Node.js **24+** | `node -v` |
| Claude Code CLI（ログイン済み） | `claude auth status` → `loggedIn: true` |
| Codex CLI（ログイン済み） | `codex login status`（`plan-review` / `impl-review` で必須） |
| Agent Teams 実験フラグ | `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` → `1` |

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

未設定の場合、`/mavsdd-implement` と `/mavsdd-fix` は preflight で **fail-closed** で停止します（`run-metadata/events.jsonl` に `policyDecision=deny` が残ります）。

### 2. install

Claude Code 上で:

```bash
/plugin marketplace add sc30gsw/multi-agent-vsdd
/plugin install multi-agent-vsdd@mavsdd
/reload-plugin
```

`/plugin install` 直後に **Claude Code session を一度閉じて開き直して**ください（hooks は `SessionStart` で配線されます）。

### 3. Usage

target repo に `cd` した状態で Claude Code を開き、以下を順に invoke します。

```text
/mavsdd-init           feature / target / verify-command を入力
/mavsdd-plan           goal を入力
/mavsdd-plan-review
/mavsdd-aggregate      scope=plan
/mavsdd-approve-plan
/mavsdd-red
/mavsdd-implement
/mavsdd-stage
/mavsdd-apply
/mavsdd-verify
```

verify が落ちたら:

```text
/mavsdd-impl-review
/mavsdd-aggregate      scope=impl
/mavsdd-approve-orphan  # finding に orphan があれば
/mavsdd-fix
```

完了承認:

```text
/mavsdd-approve-impl
```

途中で何が起きているか確認したいときは `/mavsdd-status`、続きから再開したいときは `/mavsdd-resume` を使います。

## 提供されるコンポーネント

`/plugin install` で以下が一括で配線されます。

### Agents（`agents/`）

| Agent | model / effort | 役割 |
|---|---|---|
| `mavsdd-planner` | `opus` / `xhigh` | feature を unit に分解し plan / team-composition / brief を生成 |
| `mavsdd-implementer` | `sonnet` | unit ごとに `workspace/runtime/` で実装 |
| `mavsdd-fixer` | `sonnet` | impl-review の finding cluster を修正 |
| `mavsdd-aggregator` | `sonnet` | review verdict を deterministic に集約 |

### Hooks（`hooks/hooks.json`）

| Phase | Matcher | スクリプト |
|---|---|---|
| `PreToolUse` | `Write\|Edit\|MultiEdit\|Bash` | `mavsdd-path-phase-gate`（許可外パスや phase 違反を fail-closed） |
| `PostToolUse` | `Write\|Edit\|MultiEdit\|Bash` | `mavsdd-promote-and-sentinel`（成果物の促進と watchdog） |
| `SessionStart` | — | `mavsdd-load-active`（active feature の復元） |

### Roles（`config/roles.json`）

| role | model | `allowedWritePaths`（prefix） |
|---|---|---|
| `data-modeler` | sonnet | `db/`, `src/types/` |
| `implementer` | sonnet | `src/`, `tests/` |
| `http-endpoint` | sonnet | `src/http/`, `src/api/`, `tests/http/` |
| `test-engineer` / `tester` | sonnet | `tests/` |
| `fixer` | sonnet | （空。fixer は cluster 内のターゲットファイルにのみ書ける） |

`writePaths` は **deterministic prefix match**（glob / `..` 不可、ディレクトリは trailing `/` 必須）。unit 間で `writePaths` / `writeFiles` が交差すると `roster.mjs` が hard-reject します。

### Schemas（`schemas/`）

`mavsdd-state` / `mavsdd-team-composition` / `mavsdd-operations` / `mavsdd-verdict` / `mavsdd-finding` の 5 種で全成果物を validate します。

## 安全性について

`/mavsdd-apply` は workspace copy → 本体 repo への反映を行う唯一の特権操作で、**事故防止** のために 4 層を重ねています。

1. `safeCanonical` による realpath 解決と symlink の拒否
2. `Write` / `Edit` / `MultiEdit` / `Bash` を横断する fail-closed `PreToolUse` hook
3. `MAVSDD_APPLY_TOKEN` + `.apply-lock` による特権 apply subprocess の隔離
4. operations manifest の `baseHash` 再検証による衝突検出

> v1 の保証範囲は **事故防止（accident prevention）** です。悪意ある / 侵害された agent をハードに隔離する sandbox（container / seccomp / ptrace 等）は v1 のスコープ外で、必要なら v2+ の sandbox 化を待ってください。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `/mavsdd-implement` / `/mavsdd-fix` が即停止 | `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` が `1` か確認、shell rc を再読込してから session を開き直す |
| `/mavsdd-plan-review` / `/mavsdd-impl-review` が失敗 | `codex login status` を確認 |
| `/mavsdd-*` が "command not found" になる | session を再起動。それでも駄目なら `/plugin marketplace update mavsdd` で marketplace 側を最新化してから再度 session 再起動 |
| hook 設定を変えたのに反映されない | Claude Code session を開き直す（hooks は `SessionStart` で読み込み） |
| `/mavsdd-apply` が `baseHash mismatch` で止まる | `apply` 待ちの間に target repo へ手で変更が入っている。`/mavsdd-status` で確認のうえ rebase / restage |
| 何が起きているかわからない | `tail -f .mavsdd/features/<feature>/run-metadata/events.jsonl` |

## 開発者向け（plugin 自体を改修する場合）

このリポジトリは **dogfood しながら開発できる** よう、plugin install を経由しない project-local surface も持っています。

```bash
git clone https://github.com/sc30gsw/multi-agent-vsdd.git
cd multi-agent-vsdd
./install.sh        # 環境チェック + claude plugin validate
npm test            # 93 cases
```

- `.claude/skills/mavsdd-*/SKILL.md` — project-local skill。本文は相対 path（`node scripts/cli/mavsdd.mjs ...`）で書かれており、**cwd == このリポジトリ root** のときに動きます。
- `skills/mavsdd-*/SKILL.md` — plugin 配布版。本文は `${CLAUDE_PLUGIN_ROOT}` 経由で、`/plugin install` 後に任意 cwd から動きます。
- `hooks/` と `agents/` は **plugin install 時のみ自動配線** されます。`.claude/skills/` だけを参照する dev mode では 4 層ガードのうち hook gate が欠落することに注意してください。
- `sample/sample-app/` は最小の target repo（`sumRange` / `describeRange` を持つ `node:test` プロジェクト）で、CLI を直接叩いて一周動かせます:

  ```bash
  node scripts/cli/mavsdd.mjs init \
    --feature sample-feature \
    --target sample/sample-app \
    --verify-command "npm test"
  node scripts/cli/mavsdd.mjs plan --feature sample-feature --goal "..."
  # ... plan-review / aggregate / approve-plan / red / implement / stage / apply / verify
  ```

## ライセンス

MIT
