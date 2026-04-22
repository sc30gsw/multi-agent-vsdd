# multi-agent-vsdd

Claude Code の Agent Teams と（optional で）Codex CLI を組み合わせ、**計画 → レビュー → 実装 → 検証** を **再開可能な disk-first ワークフロー**として回す Claude Code plugin です。成果物（plan / review / workspace / verification / metadata）は `.mavsdd/` 配下に正本として残り、`/mavsdd-status` / `/mavsdd-resume` で続きから再開できます。

> v1 のゴールは **plan.md を真実の源とする VSDD loop（Verification-Driven Spec Development）** の automation です。厳密 SDD はスコープ外。詳細は `docs/plan.md §0` を参照。

## Features

- **Plan scaffold** — goal から minimal な `plan.md` / `team-composition.json` / `specs/*.md` / `contexts/unit-*.md` を生成。feature 固有の要件は user が specs を編集して書き足す
- **Plan review**（optional）— Codex gpt-5.4 / Agent Teams / 手動 review のいずれかで `.mavsdd/.../reviews/plan/` に verdict を積む
- **Implement** — Sonnet implementer team が `workspace/repo/` 上で実装。`config/roles.json` の `allowedWritePaths` を超える書き込みは hook が fail-closed で拒否
- **Apply** — `MAVSDD_APPLY_TOKEN` + `.apply-lock` で隔離した apply subprocess が `operations.json` の `baseHash` を再検証してから本体 repo に反映（idempotent）
- **Verify / Fix** — `verify-command`（既定 `npm test`）を回し、失敗したら **single-agent fixer** が `workspace/repo/` を修正するループ
- **2/3 quorum + human risk ack** — reviewer の 2/3 以上が GREEN なら aggregate は GREEN（unanimous でなければ `conditional: true` が立ち、`--accept-risk "<reason>"` 必須）
- **Auditability** — 全 model 実行は `.mavsdd/features/<feature>/run-metadata/events.jsonl` に append-only 記録

## Requirements

| 要件 | 必須度 | 確認コマンド |
|---|---|---|
| Node.js 24+ | required | `node -v` |
| Claude Code CLI ログイン済み | required | `claude auth status` → `loggedIn: true` |
| Agent Teams 実験フラグ | required for implement/fix | `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` → `1` |
| Codex CLI ログイン済み | **optional** | `codex -V` + `codex login status` |
| `gh` CLI | optional | `gh auth status` |

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

> Codex が入っていない / quota 切れの場合でも、`/mavsdd-plan-review` と `/mavsdd-impl-review` 以外は全部動きます。review は後述の「Claude-only workflow」で手動 verdict を流し込めば続行可能です。

## Installation

```bash
# Claude Code 上で
/plugin marketplace add sc30gsw/multi-agent-vsdd
/plugin install multi-agent-vsdd@mavsdd
/reload-plugin
```

`/reload-plugin` 後に **Claude Code session を一度閉じて開き直してください**（hook は `SessionStart` で配線されるため）。

動作確認:

```
/mavsdd-status
```

## Workflow（v1）

```
init → plan → plan-review → aggregate → approve-plan
     → red → implement → stage → apply → verify
                                          │
                                          ├─ GREEN → impl-review → aggregate → approve-impl  ✅ done
                                          └─ RED   → impl-review → aggregate → fix → stage → apply → verify (iter N+1)
```

各 CLI 出力に **`nextSteps.nextCommand` と `nextSteps.inspect[]`** が含まれるので、次に何をして何のファイルを見るかを毎回教えてくれます。

## `.mavsdd/features/<feature>/` 内部ガイド

> **一番先に開くのは `.mavsdd/features/<feature>/INDEX.md` です。** 全 CLI コマンド実行のたびに自動再生成され、**今の phase / 進捗チェックリスト / 次に開くファイル（リンク付き）/ 次の CLI コマンド / 直近 5 イベント**を 1 ファイルで示します。README を開かずとも判断できるよう設計しています。

### INDEX.md は何を見せるか

```markdown
# <feature>  🟢 `planned`

## Progress
- [x] Initialized
- [ ] Planned ← 現在
- [ ] Plan reviewed
...

## 👉 Next
**Do**: scaffold に user 固有の要件を書き足してから plan-review に進む

**Open**:
- [`plan.md`](./plan.md) — 📌 goal / 要件を編集
- [`specs/requirements-index.json`](./specs/requirements-index.json) — REQ-* を追記
- [`specs/verification-architecture.md`](./specs/verification-architecture.md) — 検証設計
...

**Then run**:
node scripts/cli/mavsdd.mjs plan-review --feature <f> --reviewers 1

## Feature
- Goal: ...
- Target: ...

## Recent events (last 5)
...
```

VS Code / GitHub / Obsidian 等の Markdown プレビューで、`Open` セクションのリンクから **1 クリックで該当ファイルに飛べます**。

### 以下は索引としてのみ。INDEX.md に従えば読む必要なし

1. **フォルダ役割一覧** — 各ディレクトリが何のために存在するか（保管庫のラベル）
2. **必読（go/no-go）** — `nextSteps.inspect[]` にも含まれる "判断のために開く" 5 ファイル
3. **深掘りが必要になったら** — RED や障害調査のときだけ見るファイル

### (1) フォルダ役割一覧

| ディレクトリ / ファイル | 役割 | 人間の出番 |
|---|---|---|
| **`plan.md`** | feature の真実の源（goal / target / verify-command / 要件メモ） | 📌 plan 後に編集 |
| **`specs/`** | 要件・検証設計の scaffold（`requirements-index.json` / `verification-architecture.md` / `test-strategy.md` 等） | 📌 plan 後に編集 |
| **`operations/<unit>/operations.json`** | apply 候補の diff（`changedPaths` / `baseHash` / `newContent`） | 📌 apply 前に目視 |
| **`reviews/<scope>/iteration-K/`** | Codex/manual review の `aggregate.json` と `reviewer-*/verdict.json` | 📌 RED/YELLOW のとき開く |
| **`verification/`** | `verify-command` の結果（`summary.json` / `reports/<unit>.md`） | 📌 fail のとき下りる |
| **`fixes/orphan/<id>/`** | 修正 cluster の scope と resolution | 📌 fix_required のとき開く |
| `feature-state.json` | 現在の phase / 承認状態 / review iteration 数 | CLI に任せる |
| `contexts/` | Planner / Reviewer に渡す brief（`planner-brief.md` / `codex-rubric-*.md` / `unit-*.md`） | 通常触らない |
| `red/` | failing test の定義（`test-matrix.json` / `failing-tests.json` / `red-phase.log`） | 通常触らない |
| `implementations/<unit>/status.json` | 各 unit の実装完了状態 | `git diff workspace/repo/` の方が速い |
| `workspace/base\|repo\|runtime/` | implementer 作業コピー（`.gitignore` 済） | 通常触らない |
| `traceability/` | 要件 ↔ 実装のコントラクト追跡（`coverage-matrix.json` / `contract-chain.jsonl`） | 通常触らない |
| `team-runtime/` | Claude Agent Team の生の入出力（`claude-*-raw-response.json` / `task-ledger.jsonl`） | 障害調査用 |
| `run-metadata/events.jsonl` | 全 CLI 実行の append-only 追跡（policy deny 含む） | 監査 / trouble-shoot |
| `human-approvals.jsonl` | approve-plan / approve-impl の全記録（`--accept-risk` 含む） | 監査 |
| `apply-log.jsonl` | apply の pre/post hash と `applyTxnId` | 監査 / `baseHash mismatch` 時 |

### (2) 必読ファイル（go/no-go の判断だけならこの 5 つ）

| Phase | 開くファイル | 判断する内容 |
|---|---|---|
| `planned` | `plan.md` + `specs/requirements-index.json` + `specs/verification-architecture.md` + `specs/test-strategy.md` | **scaffold を user が書き足す**（唯一「複数ファイル必読」の phase） |
| `plan_reviewed` / `impl_reviewed` | `reviews/<scope>/iteration-K/aggregate.json` | `verdict` と `conditional` の値。RED/YELLOW なら `reviewer-*/verdict.json` に下りる |
| `staged` | `operations/<unit>/operations.json` | **apply 直前の唯一の human gate**。`changedPaths[]` を目視 |
| `verified` | `verification/summary.json` | `success: true/false`。fail なら `verification/reports/<unit>.md` に下りる |
| `fix_required` | `fixes/orphan/<cluster-id>/cluster.json` ＋ `resolution.json` | 修正 cluster の scope と approval 状態 |

**このテーブルを暗記する必要はない** — `nextSteps.inspect[]` に毎回入っています。

### (3) 深掘りが必要になったら

- **apply が `baseHash mismatch` で落ちた** → `apply-log.jsonl` で直近の applyTxnId を確認 → `operations/<unit>/operations.json` で `baseHash` を再生成
- **verify が RED** → `verification/reports/<unit>.md` で stdout/stderr を読む
- **review が RED で理由が不明** → `reviews/<scope>/iteration-K/reviewer-*/verdict.raw.json` で生の Codex 応答を確認
- **何が動いているか分からない** → `tail -f run-metadata/events.jsonl` で全実行を stream
- **implement / fix の出力が空** → `team-runtime/claude-*-raw-response.json` で stderr / exit code を確認
- **承認チェーンを辿りたい** → `human-approvals.jsonl`（各エントリに manifestHash / aggregateHash / acceptRisk）

```bash
# 平時の "全体監視" は 1 コマンドで足りる
tail -f .mavsdd/features/<feature>/run-metadata/events.jsonl
```

## Claude-only workflow（Codex 無しで回す）

plan-review / impl-review 以外は Codex 不要です。review だけ手動 mock で通す手順:

```bash
# plan-review ステップ
mkdir -p .mavsdd/features/<f>/reviews/plan/iteration-1/reviewer-1
cat > .mavsdd/features/<f>/reviews/plan/iteration-1/manifest.json <<'EOF'
{"feature":"<f>","scope":"plan","iteration":1,"reviewers":["1"],"artifactsToReview":[]}
EOF
cat > .mavsdd/features/<f>/reviews/plan/iteration-1/reviewer-1/verdict.json <<'EOF'
{"verdict":"GREEN","coverageComplete":true,"findings":[]}
EOF
# state の reviewIterations.plan を 1 に上げる
node -e 'const fs=require("fs");const p=".mavsdd/features/<f>/feature-state.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));s.reviewIterations.plan=1;fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n")'
node scripts/cli/mavsdd.mjs aggregate --feature <f> --scope plan
node scripts/cli/mavsdd.mjs approve-plan --feature <f> --by <you>   # --accept-risk が必要なら付与
```

impl-review も同じパターン（`reviews/impl/iteration-K/`）です。**Codex が戻ってきたら `/mavsdd-plan-review --reviewers 1` に切り替えるだけ**で adversarial review 経路に復帰できます。

## 2/3 quorum と human risk ack

- `reviewers: 3` で回したとき **3 人が全員 GREEN** → aggregate GREEN、approve-plan/impl は `--by` だけで通る
- **2 人 GREEN + 1 RED/YELLOW** → aggregate GREEN だが `conditional: true`、approve に `--accept-risk "<reason>"` が**必須**。`human-approvals.jsonl` に reason がそのまま記録される
- **critical severity の RED がある** → 2/3 GREEN でも aggregate は RED に戻す（approve-impl 不可）
- `reviewers: 1` のときは 1/1 で GREEN、RED なら通らないという素直な挙動

## Commands

すべての `/mavsdd-*` skill は内部で同名の trusted CLI subcommand（`scripts/cli/mavsdd.mjs <subcmd>`）を呼び、結果に `nextSteps` を添えて返します。

| Slash command | CLI subcommand | 主な引数 |
|---|---|---|
| `/mavsdd-init` | `init` | `--feature`, `--target`, `--verify-command` |
| `/mavsdd-plan` | `plan` | `--feature`, `--goal` |
| `/mavsdd-plan-review` | `plan-review` | `--feature`, `--reviewers`, `--timeout-ms` |
| `/mavsdd-aggregate` | `aggregate` | `--feature`, `--scope plan\|impl` |
| `/mavsdd-approve-plan` | `approve-plan` | `--feature`, `--by`, `--accept-risk` |
| `/mavsdd-red` | `red` | `--feature` |
| `/mavsdd-implement` | `implement` | `--feature` |
| `/mavsdd-stage` | `stage` | `--feature` |
| `/mavsdd-apply` | `apply` | `--feature` |
| `/mavsdd-verify` | `verify` | `--feature` |
| `/mavsdd-impl-review` | `impl-review` | `--feature`, `--reviewers`, `--timeout-ms` |
| `/mavsdd-approve-orphan` | `approve-orphan` | `--feature`, `--cluster-id`, `--verdict`, `--by` |
| `/mavsdd-fix` | `fix` | `--feature` |
| `/mavsdd-approve-impl` | `approve-impl` | `--feature`, `--by`, `--accept-risk` |
| `/mavsdd-status` | `status` | `--feature` |
| `/mavsdd-resume` | `resume` | `--feature` |

## What's Included

### Agents（`agents/`）

| Agent | model / effort | 役割 |
|---|---|---|
| `mavsdd-planner` | `opus` / `xhigh`（v2 で真に配線。v1 は scaffold のみ） | feature を 1-5 unit に分解し plan / team-composition を生成 |
| `mavsdd-implementer` | `sonnet` | unit ごとに `workspace/repo/` で実装 |
| `mavsdd-fixer` | `sonnet`（**single-agent**） | impl-review の finding cluster を 1 回で修正 |
| `mavsdd-aggregator` | `sonnet` | review verdict を deterministic に集約 |

### Hooks（`hooks/hooks.json`）

| Phase | Matcher | スクリプト |
|---|---|---|
| `PreToolUse` | `Write\|Edit\|MultiEdit\|Bash` | `mavsdd-path-phase-gate`（scope 外書き込みを fail-closed） |
| `PostToolUse` | `Write\|Edit\|MultiEdit\|Bash` | `mavsdd-promote-and-sentinel`（`.inbox/verdict.json` → canonical rename、quorum で `.ready` touch） |
| `SessionStart` | — | `mavsdd-load-active`（active feature を banner で表示） |

### Roles（`config/roles.json`）

| role | model | `allowedWritePaths`（prefix） |
|---|---|---|
| `data-modeler` | sonnet | `db/`, `src/types/` |
| `implementer` | sonnet | `src/`, `tests/` |
| `http-endpoint` | sonnet | `src/http/`, `src/api/`, `tests/http/` |
| `test-engineer` / `tester` | sonnet | `tests/` |
| `auditor` | sonnet | `specs/` |
| `fixer` | sonnet | （空。fixer は cluster scope に従う） |

`writePaths` は **deterministic prefix match**（glob / `..` 不可、ディレクトリは trailing `/` 必須）。

### Schemas（`schemas/`）

`mavsdd-state` / `mavsdd-team-composition` / `mavsdd-operations` / `mavsdd-verdict` / `mavsdd-finding` の 5 種で全成果物を validate。operations manifest は plan §15.1 準拠で `ops` / `unit` / `sha256:<hex>` / octal string mode。verdict は plan §17.1.1 の rich fields（`evaluation` / `judgement` / `recommendedAction` / `readSetProducer` 等）を optional で受容。

## Security

`/mavsdd-apply` は workspace copy → 本体 repo への反映を行う唯一の特権操作で、**事故防止** のために 4 層を重ねています。

1. `safeCanonical` による realpath 解決と symlink の拒否
2. `Write` / `Edit` / `MultiEdit` / `Bash` を横断する fail-closed `PreToolUse` hook
3. `MAVSDD_APPLY_TOKEN` + `.apply-lock` による特権 apply subprocess の隔離
4. operations manifest の `baseHash` 再検証による衝突検出

> v1 の保証範囲は **事故防止（accident prevention）** です。悪意ある / 侵害された agent をハードに隔離する sandbox（container / seccomp / ptrace 等）は v1 のスコープ外で、必要なら v2+ の sandbox 化を待ってください。

## 実行上の注意

### `/mavsdd-implement` と `/mavsdd-fix` の子 Claude セッション

`/mavsdd-implement` と `/mavsdd-fix` は内部で `claude -p` で子 Claude を spawn します。**親の Claude Code session の中から spawn された子 Claude は、認可/session 継承の競合でストールする**既知事象があります。そのためこの 2 コマンドは次のどちらかで実行してください:

1. **通常のターミナル**（Claude Code 外）から `node scripts/cli/mavsdd.mjs implement --feature <f>` を直接実行
2. **別プロジェクトの** Claude Code session から `/mavsdd-implement` を発火

15 分待って応答が無ければ `MAVSDD_IMPLEMENT_TIMEOUT_MS` 経由で fail-closed に落ち、`run-metadata/events.jsonl` に `policyReason: "process timed out after ..."` が残ります。

## Troubleshooting

| 症状 | 対処 |
|---|---|
| `/mavsdd-implement` / `/mavsdd-fix` が 5 分以上応答しない | 前節「実行上の注意」。`MAVSDD_IMPLEMENT_TIMEOUT_MS=300000` で timeout を短めに試す |
| `/mavsdd-plan-review` / `/mavsdd-impl-review` が失敗 | `codex login status` を確認。quota 切れなら前述の「Claude-only workflow」で手動 verdict 流し込み |
| `approve-plan` / `approve-impl` が `requires --accept-risk` と言う | aggregate が `conditional: true`（2/3 GREEN 非 unanimous）。reason をつけて再実行 |
| `/mavsdd-apply` が `baseHash mismatch` で止まる | target repo に手で変更が入っている。`/mavsdd-status` → rebase / restage |
| `/mavsdd-*` が "command not found" | session 再起動。だめなら `/plugin marketplace update mavsdd` |
| hook の挙動変更が反映されない | Claude Code session を開き直す（hook は `SessionStart` で配線） |
| 何が起きているかわからない | `tail -f .mavsdd/features/<feature>/run-metadata/events.jsonl` |

## Development

```bash
git clone https://github.com/sc30gsw/multi-agent-vsdd.git
cd multi-agent-vsdd
./install.sh        # 環境チェック + claude plugin validate
npm test            # 105+ cases（schemas / aggregate / apply / hooks / state / ...）
```

- `.claude/skills/mavsdd-*/SKILL.md` — project-local dev mode（相対 path）
- `skills/mavsdd-*/SKILL.md` — plugin 配布版（`${CLAUDE_PLUGIN_ROOT}` 経由）
- `docs/plan.md §0` に v1 スコープの最終判断が書かれています。ここが実装と齟齬する箇所の優先規定

## License

MIT
