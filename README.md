# multi-agent-vsdd

Claude Code の Agent Teams と Codex CLI を組み合わせ、計画 → レビュー → 実装 → 検証までを **再開可能な disk-first ワークフロー** として回す Claude Code plugin です。すべての成果物（plan / review / workspace / verification / metadata）は `.mavsdd/` 配下に正本として残り、いつでも `mavsdd status` / `mavsdd resume` で続きから再開できます。

## できること

- **Plan** — Opus planner（`agents/mavsdd-planner.md`、`effort: xhigh`）が goal を 1〜5 unit に分解し、`plan.md` / `team-composition.json` / `contexts/unit-*.md` を生成
- **Plan Review** — Codex jury（`templates/codex-rubric-plan.md`）が独立に plan を採点し、verdict / digest / raw response を `.mavsdd/.../reviews/plan/` に保存
- **Implement** — Sonnet implementer team が `workspace/runtime/` 上で実装。`config/roles.json` で宣言した `allowedWritePaths` を超える書き込みは hook が fail-closed で拒否
- **Apply** — `MAVSDD_APPLY_TOKEN` + `.apply-lock` で隔離された apply subprocess が、operations manifest の `baseHash` を再検証してから本体 repo に反映
- **Verify / Fix** — `verify-command`（既定で `npm test`）を回し、失敗したら Codex impl-review → 修正クラスタ → fixer team のループで詰める
- **Auditability** — 全 model 実行は `.mavsdd/features/<feature>/run-metadata/events.jsonl` に append-only で記録

## インストール

### 1. 前提

| 要件 | 確認 |
|---|---|
| Node.js **24+** | `node -v` |
| Claude Code CLI（ログイン済み） | `claude auth status` → `loggedIn: true` |
| Codex CLI（ログイン済み） | `codex login status`（`plan-review` / `impl-review` で必須） |
| GitHub CLI | `gh auth status`（GitHub 連携を使う場合） |
| Agent Teams 実験フラグ | `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` → `1` |

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

未設定の場合、`mavsdd implement` と `mavsdd fix` は preflight で **fail-closed** で停止します（`run-metadata/events.jsonl` に `policyDecision=deny` が残ります）。

### 2. plugin の install

本 repo は `.claude-plugin/marketplace.json` を**同梱していない**ため、現状は **ローカル clone を Claude Code に登録する**フローです。

```bash
git clone https://github.com/sc30gsw/multi-agent-vsdd.git
cd multi-agent-vsdd
./install.sh
```

`install.sh` は以下を行います:

- `claude plugins validate <repo>` で `.claude-plugin/plugin.json` を検証
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` の export 状況を表示
- `codex` CLI が PATH にあるかをチェック
- 次のステップ（`/plugin` 起動 / smoke test / sample feature 起動）を案内

そのあと Claude Code 上で:

```text
/plugin
```

を開き、上記ローカルディレクトリを plugin source として登録してください。

> **`/plugin marketplace add` / `/plugin reload` について**
> - `/plugin marketplace add <repo>` は marketplace を取り込むコマンドで、登録対象 repo に `.claude-plugin/marketplace.json` が必要です。本 repo は単一 plugin の同梱のみで marketplace を提供していないため、**現状このコマンドは不要**です（将来 marketplace 化する場合は別途案内します）。
> - hooks は `SessionStart` で読み込まれます。`hooks.json` や `plugin.json` を更新したら **Claude Code session を開き直して**ください。Claude Code に標準の `/plugin reload` slash command はありません。

### 3. 動作確認

```bash
node scripts/cli/mavsdd.mjs status --feature sample-feature
```

JSON で `phase` などが返れば install 完了です（feature 未初期化なら "not initialized" に類するエラーで OK — CLI 自体が動くことの確認になります）。

便宜のために `package.json` に alias もあります:

```bash
npm run verify:sample
```

## 利用フロー

実行コマンドは **trusted CLI（`node scripts/cli/mavsdd.mjs ...`）** が正本です。Claude Code 上で `mavsdd-*` skill を invoke すると、各 skill が `allowed-tools` で固定された CLI 1 行だけを Bash で走らせます（skill は `disable-model-invocation: true` のため、model が勝手に呼ぶことはありません）。

### sample feature を一周する

`sample/sample-app/` は最小の target repo です（`sumRange` / `describeRange` を提供する `node:test` プロジェクト）。以下で全 phase を一周できます。

```bash
node scripts/cli/mavsdd.mjs init \
  --feature sample-feature \
  --target sample/sample-app \
  --verify-command "npm test"

node scripts/cli/mavsdd.mjs plan \
  --feature sample-feature \
  --goal "Add sumRange(start, end) and describeRange(start, end) to the sample app"

node scripts/cli/mavsdd.mjs plan-review --feature sample-feature --reviewers 1
node scripts/cli/mavsdd.mjs aggregate   --feature sample-feature --scope plan
node scripts/cli/mavsdd.mjs approve-plan --feature sample-feature --by "<your-name>"

node scripts/cli/mavsdd.mjs red --feature sample-feature

CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  node scripts/cli/mavsdd.mjs implement --feature sample-feature

node scripts/cli/mavsdd.mjs stage  --feature sample-feature
node scripts/cli/mavsdd.mjs apply  --feature sample-feature
node scripts/cli/mavsdd.mjs verify --feature sample-feature
```

verify が落ちたら:

```bash
node scripts/cli/mavsdd.mjs impl-review --feature sample-feature --reviewers 1
node scripts/cli/mavsdd.mjs aggregate   --feature sample-feature --scope impl
# 必要なら orphan finding を承認
node scripts/cli/mavsdd.mjs approve-orphan \
  --feature sample-feature --cluster-id <cluster-id> --verdict approve --by "<your-name>"
node scripts/cli/mavsdd.mjs fix --feature sample-feature
```

完了承認:

```bash
node scripts/cli/mavsdd.mjs approve-impl --feature sample-feature --by "<your-name>"
```

## 提供されるコンポーネント

### Skills（Claude Code 上で trusted CLI を 1 行ずつ実行する wrapper）

| Skill | 走らせる CLI |
|---|---|
| `mavsdd-init` | `mavsdd.mjs init --feature ... --target ... --verify-command ...` |
| `mavsdd-plan` | `mavsdd.mjs plan --feature ... --goal ...` |
| `mavsdd-plan-review` | `mavsdd.mjs plan-review --feature ... --reviewers N` |
| `mavsdd-aggregate` | `mavsdd.mjs aggregate --feature ... --scope plan\|impl` |
| `mavsdd-approve-plan` | `mavsdd.mjs approve-plan --feature ... --by ...` |
| `mavsdd-red` | `mavsdd.mjs red --feature ...` |
| `mavsdd-implement` | `mavsdd.mjs implement --feature ...`（要 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`） |
| `mavsdd-stage` | `mavsdd.mjs stage --feature ...` |
| `mavsdd-apply` | `mavsdd.mjs apply --feature ...` |
| `mavsdd-verify` | `mavsdd.mjs verify --feature ...` |
| `mavsdd-impl-review` | `mavsdd.mjs impl-review --feature ... --reviewers N` |
| `mavsdd-approve-impl` | `mavsdd.mjs approve-impl --feature ... --by ...` |
| `mavsdd-approve-orphan` | `mavsdd.mjs approve-orphan --feature ... --cluster-id ... --verdict ... --by ...` |
| `mavsdd-fix` | `mavsdd.mjs fix --feature ...`（要 Agent Teams フラグ） |
| `mavsdd-resume` | `mavsdd.mjs resume --feature ...` |
| `mavsdd-status` | `mavsdd.mjs status --feature ...` |

### Agents（`agents/`）

| Agent | model / effort | 役割 |
|---|---|---|
| `mavsdd-planner` | `opus` / `xhigh` | feature を unit に分解し plan / team-composition / brief を生成 |
| `mavsdd-implementer` | `sonnet` | unit ごとに `workspace/runtime/` で実装 |
| `mavsdd-fixer` | `sonnet` | impl-review の finding cluster を修正 |
| `mavsdd-aggregator` | `sonnet` | review verdict を deterministic に集約 |

### Hooks（`hooks/hooks.json` — install 時に自動配線）

| Phase | Matcher | スクリプト |
|---|---|---|
| `PreToolUse` | `Write\|Edit\|MultiEdit\|Bash` | `mavsdd-path-phase-gate`（許可外パスや phase 違反を fail-closed） |
| `PostToolUse` | `Write\|Edit\|MultiEdit\|Bash` | `mavsdd-promote-and-sentinel`（成果物の促進と watchdog） |
| `SessionStart` | — | `mavsdd-load-active`（active feature の復元） |

### Schemas（`schemas/` — 全成果物が schema validate される）

`mavsdd-state` / `mavsdd-team-composition` / `mavsdd-operations` / `mavsdd-verdict` / `mavsdd-finding`

### Roles（`config/roles.json`）

| role | model | `allowedWritePaths`（prefix） |
|---|---|---|
| `data-modeler` | sonnet | `db/`, `src/types/` |
| `implementer` | sonnet | `src/`, `tests/` |
| `http-endpoint` | sonnet | `src/http/`, `src/api/`, `tests/http/` |
| `test-engineer` | sonnet | `tests/` |
| `tester` | sonnet | `tests/` |
| `fixer` | sonnet | （空。fixer は cluster 内のターゲットファイルにのみ書ける） |

`writePaths` は **deterministic prefix match**（glob / `..` 不可、ディレクトリは trailing `/` 必須）。unit 間で `writePaths` / `writeFiles` が交差すると `roster.mjs` が hard-reject します。

## 安全性について（Threat Model 抜粋）

`mavsdd apply` は workspace copy → 本体 repo への反映を行う唯一の特権操作で、**事故防止** のために 4 層を重ねています。

1. `safeCanonical` による realpath 解決と symlink の拒否
2. `Write` / `Edit` / `MultiEdit` / `Bash` を横断する fail-closed `PreToolUse` hook
3. `MAVSDD_APPLY_TOKEN` + `.apply-lock` による特権 apply subprocess の隔離
4. operations manifest の `baseHash` 再検証による衝突検出

> v1 の保証範囲は **事故防止（accident prevention）** です。悪意ある / 侵害された agent をハードに隔離する sandbox（container / seccomp / ptrace 等）は v1 のスコープ外で、必要なら v2+ の sandbox 化を待ってください。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `mavsdd implement` / `mavsdd fix` が即停止する | `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` が `1` か確認、shell rc を再読込してから session を開き直す |
| `mavsdd plan-review` / `mavsdd impl-review` が失敗する | `codex login status` を確認 |
| hook 設定を変えたのに反映されない | Claude Code session を新しく開き直す（hooks は `SessionStart` で読み込み） |
| `mavsdd apply` が `baseHash mismatch` で止まる | `apply` 待ちの間に target repo へ手で変更が入っている。`mavsdd status` で確認のうえ rebase / restage |
| 何が起きているかわからない | `tail -f .mavsdd/features/<feature>/run-metadata/events.jsonl` |
| `claude plugins validate` が失敗する | `.claude-plugin/plugin.json` を編集後は再度 `./install.sh` を実行 |

## ライセンス

MIT
