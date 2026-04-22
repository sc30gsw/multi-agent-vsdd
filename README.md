# multi-agent-vsdd

Claude Code の Agent Teams と Codex CLI を組み合わせ、**計画 → レビュー → 実装 → 検証** を再開可能な disk-first ワークフローとして回す Claude Code plugin です。すべての成果物（plan / review / workspace / verification / metadata）は `.mavsdd/` 配下に正本として残り、いつでも `/mavsdd-status` / `/mavsdd-resume` で続きから再開できます。

## Features

- **Plan** — Opus planner（`effort: xhigh`）が goal を 1〜5 unit に分解し、`plan.md` / `team-composition.json` / `contexts/unit-*.md` を生成
- **Plan Review** — Codex jury が独立に plan を採点し、verdict / digest / raw response を `.mavsdd/.../reviews/plan/` に保存
- **Implement** — Sonnet implementer team が `workspace/runtime/` 上で実装。`config/roles.json` の `allowedWritePaths` を超える書き込みは hook が fail-closed で拒否
- **Apply** — `MAVSDD_APPLY_TOKEN` + `.apply-lock` で隔離された apply subprocess が、operations manifest の `baseHash` を再検証してから本体 repo に反映
- **Verify / Fix** — `verify-command`（既定で `npm test`）を回し、失敗したら Codex impl-review → 修正クラスタ → fixer team のループで詰める
- **Auditability** — 全 model 実行は `.mavsdd/features/<feature>/run-metadata/events.jsonl` に append-only で記録

## Requirements

| 要件 | 確認コマンド |
|---|---|
| Node.js **24 以上** | `node -v`（`v24.0.0` 以上であれば OK） |
| Claude Code CLI（ログイン済み） | `claude auth status` → `loggedIn: true` |
| Codex CLI（ログイン済み） | `codex login status` |
| Agent Teams 実験フラグ | `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` → `1` |

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

未設定の場合、`/mavsdd-implement` と `/mavsdd-fix` は preflight で **fail-closed** で停止します（`run-metadata/events.jsonl` に `policyDecision=deny` が残ります）。

## Installation

Claude Code 上で:

```bash
/plugin marketplace add sc30gsw/multi-agent-vsdd
/plugin install multi-agent-vsdd@mavsdd
/reload-plugin
```

`/reload-plugin` 後に **Claude Code session を一度閉じて開き直して**ください（hooks は `SessionStart` で配線されるため、reload だけでは hook が有効になりません）。

確認:

```bash
/mavsdd-status
```

が "no active feature" 等を返せば配線成功です。

## Usage

### Workflow

```
init → plan → plan-review → aggregate → approve-plan
     → red → implement → stage → apply → verify
                                          │
                                          └─ 失敗 → impl-review → aggregate
                                                  → (approve-orphan) → fix
                                                  → stage → apply → verify
                                          └─ 成功 → approve-impl  ✅
```

各ステップは `/mavsdd-<step>` slash command として用意されています。任意の target repo に `cd` してから Claude Code を開き、上から順に invoke してください。

### Step-by-step（最小例）

target repo を `~/code/my-app`、追加したい機能を「`sumRange(start, end)` を実装」とした場合:

1. **`/mavsdd-init`** — feature workspace を `.mavsdd/features/sum-range/` 配下に作成

   入力:
   - `feature`: `sum-range`
   - `target`: `.`（cwd を target にする場合）
   - `verify-command`: `npm test`

2. **`/mavsdd-plan`** — Opus planner が unit に分解し `plan.md` / `team-composition.json` を生成

   入力:
   - `goal`: `Add sumRange(start, end) returning the inclusive sum, with tests`

3. **`/mavsdd-plan-review`** — Codex jury が plan を採点（`reviewers` 既定 1）
4. **`/mavsdd-aggregate`** — `scope=plan` を指定して verdict を集約
5. **`/mavsdd-approve-plan`** — `by` に承認者名を入れて plan を確定
6. **`/mavsdd-red`** — テストファースト用に failing test を `workspace/runtime/` に置く
7. **`/mavsdd-implement`** — implementer team が unit ごとに実装（要 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）
8. **`/mavsdd-stage`** — workspace の差分を operations manifest にまとめ `baseHash` を取る
9. **`/mavsdd-apply`** — 特権 subprocess が manifest を本体 repo に反映
10. **`/mavsdd-verify`** — `verify-command`（ここでは `npm test`）を実行

### verify が落ちた場合

```bash
/mavsdd-impl-review               # Codex が原因を採点
/mavsdd-aggregate    scope=impl   # finding を cluster に集約
/mavsdd-approve-orphan            # plan に紐付かない finding があれば承認
/mavsdd-fix                       # fixer team が cluster ごとに修正
/mavsdd-stage → /mavsdd-apply → /mavsdd-verify   # ループ
```

verify が通ったら:

```bash
/mavsdd-approve-impl   by=<your-name>
```

### 状態の確認・再開

| やりたいこと | コマンド |
|---|---|
| 今どの phase にいるか見たい | `/mavsdd-status` |
| 別 session から続きを再開したい | `/mavsdd-resume` |
| 詳細な実行ログを追いたい | `tail -f .mavsdd/features/<feature>/run-metadata/events.jsonl` |

## Commands

すべての `/mavsdd-*` skill は内部で同名の trusted CLI subcommand（`scripts/cli/mavsdd.mjs <subcmd>`）を呼びます。

| Slash command | CLI subcommand | 主な引数 |
|---|---|---|
| `/mavsdd-init` | `init` | `--feature`, `--target`, `--verify-command` |
| `/mavsdd-plan` | `plan` | `--feature`, `--goal` |
| `/mavsdd-plan-review` | `plan-review` | `--feature`, `--reviewers` |
| `/mavsdd-aggregate` | `aggregate` | `--feature`, `--scope plan\|impl` |
| `/mavsdd-approve-plan` | `approve-plan` | `--feature`, `--by` |
| `/mavsdd-red` | `red` | `--feature` |
| `/mavsdd-implement` | `implement` | `--feature` |
| `/mavsdd-stage` | `stage` | `--feature` |
| `/mavsdd-apply` | `apply` | `--feature` |
| `/mavsdd-verify` | `verify` | `--feature` |
| `/mavsdd-impl-review` | `impl-review` | `--feature`, `--reviewers` |
| `/mavsdd-approve-orphan` | `approve-orphan` | `--feature`, `--cluster-id`, `--verdict`, `--by` |
| `/mavsdd-fix` | `fix` | `--feature` |
| `/mavsdd-approve-impl` | `approve-impl` | `--feature`, `--by` |
| `/mavsdd-status` | `status` | `--feature` |
| `/mavsdd-resume` | `resume` | `--feature` |

## What's Included

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

## Security

`/mavsdd-apply` は workspace copy → 本体 repo への反映を行う唯一の特権操作で、**事故防止** のために 4 層を重ねています。

1. `safeCanonical` による realpath 解決と symlink の拒否
2. `Write` / `Edit` / `MultiEdit` / `Bash` を横断する fail-closed `PreToolUse` hook
3. `MAVSDD_APPLY_TOKEN` + `.apply-lock` による特権 apply subprocess の隔離
4. operations manifest の `baseHash` 再検証による衝突検出

> v1 の保証範囲は **事故防止（accident prevention）** です。悪意ある / 侵害された agent をハードに隔離する sandbox（container / seccomp / ptrace 等）は v1 のスコープ外で、必要なら v2+ の sandbox 化を待ってください。

## Troubleshooting

| 症状 | 対処 |
|---|---|
| `/mavsdd-implement` / `/mavsdd-fix` が即停止 | `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` が `1` か確認、shell rc を再読込してから session を開き直す |
| `/mavsdd-plan-review` / `/mavsdd-impl-review` が失敗 | `codex login status` を確認 |
| `/mavsdd-*` が "command not found" | session を再起動。それでも駄目なら `/plugin marketplace update mavsdd` で marketplace 側を最新化してから再度 session 再起動 |
| hook 設定を変えたのに反映されない | Claude Code session を開き直す（hooks は `SessionStart` で読み込み） |
| `/mavsdd-apply` が `baseHash mismatch` で止まる | apply 待ちの間に target repo へ手で変更が入っている。`/mavsdd-status` で確認のうえ rebase / restage |
| 何が起きているかわからない | `tail -f .mavsdd/features/<feature>/run-metadata/events.jsonl` |

## Development

plugin 自体を改修したい人向け。dogfood できるよう project-local surface も同梱しています。

```bash
git clone https://github.com/sc30gsw/multi-agent-vsdd.git
cd multi-agent-vsdd
./install.sh        # 環境チェック + claude plugin validate
npm test            # 93 cases
```

- `.claude/skills/mavsdd-*/SKILL.md` — project-local。本文は相対 path（`node scripts/cli/mavsdd.mjs ...`）で書かれ、**cwd == このリポジトリ root** のときに動きます。
- `skills/mavsdd-*/SKILL.md` — plugin 配布版。本文は `${CLAUDE_PLUGIN_ROOT}` 経由で、`/plugin install` 後に任意 cwd から動きます。
- `hooks/` と `agents/` は **plugin install 時のみ自動配線** されます。`.claude/skills/` だけを参照する dev mode では 4 層ガードのうち hook gate が欠落することに注意。
- `sample/sample-app/` は最小の target repo（`sumRange` / `describeRange` を持つ `node:test` プロジェクト）。CLI を直接叩いて一周動作確認できます:

  ```bash
  node scripts/cli/mavsdd.mjs init \
    --feature sample-feature \
    --target sample/sample-app \
    --verify-command "npm test"
  node scripts/cli/mavsdd.mjs plan --feature sample-feature --goal "..."
  # plan-review → aggregate → approve-plan → red → implement → stage → apply → verify
  ```

## License

MIT
