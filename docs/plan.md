# 計画: multi-agent-vsdd (mavsdd) — Multi-Agent VSDD Harness OSS（rev-11 / imp）

## 0. v1 Scope Reduction（2026-04-22 時点での最終判断）

本 plan は rev-10 まで "rigid SDD + multi-reviewer jury" を前提に記述していたが、実運用検証を経て **v1 はより軽量な Verification-Driven Spec Development（VSDD）** に絞る。以降の §1〜§28 は **"理想像"** として残すが、実装と運用判断は本 §0 が優先する。

### 0.1 v1 の scope

本 plan 全体が目指すのは次の loop を automation することに限る。

```
plan-mode → plan.md → codex レビュー → 実装 → codex レビュー
```

**`plan.md` を single source of truth** として扱う。`specs/*.md`（behavioral-spec / verification-architecture / test-strategy / reuse-evidence / requirements-index / convergence-checklist）は **"optional scaffold"** であり、feature の性質に応じて user が拡充する。厳密な SDD（requirements が逐一 REQ id に紐付き、各 artifact が相互参照される）は v1 のスコープ外。

### 0.2 Quorum は 2/3 GREEN + 人間リスク承認

Codex reviewer は adversarial なので全員 GREEN になることはほぼ無い（実測でも最低 3 iteration 回す必要があった）。v1 は次のルールとする。

- eligible reviewer の **2/3 以上が GREEN** のとき aggregate は GREEN
- ただし **unanimous でない場合は `conditional: true`** を立てる
- `/mavsdd-approve-impl`（および `approve-plan`）は `conditional === true` のとき **`--accept-risk "<reason>"` の明示**を要求する。`human-approvals.jsonl` にそのまま記録する
- **default reviewer 数は 3**（2/3 quorum が意味を持つ最小構成）。`--reviewers 1` は demo / debug 用の escape hatch

### 0.3 Reviewer backend は Codex 既定 + `--backend mock` fallback

Codex は契約 / quota 次第で利用できない user がいる。v1 は `/mavsdd-plan-review` / `/mavsdd-impl-review` に `--backend codex|mock` flag を持つ:

- `codex`（default）— `codex exec --model gpt-5.4 --sandbox read-only` で adversarial review を回す
- `mock` — 人間が verdict を注入する代替経路。CLI は N 体分の `verdict.json` を synth、各 verdict に **`meta.source: "human-mock"` / `meta.reason` / `meta.reviewedBy` / `meta.reviewedAt`** を埋め込んで audit trail を保持。`run-metadata/events.jsonl` にも `provider: "human-mock"` で記録
- `agent-team` backend（Claude Agent Team で review 代替）は v1.1 で追加予定

### 0.4 Plan scaffold は minimal、ハードコード REQ を撤廃

rev-10 までの `buildRequirements()` は `REQ-1a..REQ-7` を feature 内容に関係なく埋め込んでおり、これが Codex の **初回 RED 不具合**の根本原因だった。v1 は次に縮小する。

- `requirements-index.json` は **goal 由来の 1 件**（"Complete the feature as stated in the goal, verified by `<verify-command>` passing"）のみ
- `verification-architecture.md` / `test-strategy.md` / `reuse-evidence.md` はテンプレートの skeleton のみ、feature 固有の REQ は user が書き足す
- Codex は "plan に詳細が足りない" と指摘できるが、ハードコード不整合は発火しない

### 0.5 Agent の単位

- **Implementer**: 引き続き Claude Agent Team（unit 数は plan.md の `proposed units` に従う）
- **Fixer**: **single-agent 実行**に戻す（Agent Team を spawn しない）
- **Planner**: v1 では template scaffold で十分。v2 以降で opus + xhigh の real LLM planner を配線する予定
- **Aggregator**: 引き続き deterministic CLI

### 0.6 既知の UX 制約（README に記載済み）

- `/mavsdd-implement` / `/mavsdd-fix` は nested Claude Code session 内では子 Claude の stall が発生するため、外部ターミナルからの実行を推奨する
- Codex が `touched_files` を自発的に埋めない現状では coverage-based quorum 除外が no-op に近い。CLI preload で artifact 読み取り記録を補う案は v1.1 以降

### 0.7 §1〜§28 と §0 の関係

- `§1〜§28` は plan の **理想像 / 長期目標** として残す。用語・契約形状・state machine は原則 §§準拠
- `§0` に矛盾する記述は **§0 を優先**する
- 具体的には次が §0 で overrides される:
  - §8.2 reviewer 数（v1 は 1〜3 まで許容）
  - §19.3 aggregation mode（v1 は 2/3 GREEN + conditional flag）
  - §20 fixer cluster（v1 は single agent 実行、cluster は 1 本に collapse してよい）
  - §10.2 plan 生成（v1 は goal 由来 1-REQ scaffold）

### 0.8 Operator UX 契約（v1 で新規追加）

ユーザーが「次に何をして、どのファイルを読めばよいか」を毎回自分で判断しなくて済むよう、v1 は次の 2 つの contract を保証する。

#### 0.8.1 CLI は常に `nextSteps` を返す

`scripts/cli/mavsdd.mjs <command>` の state-mutating 呼び出し（`init` / `plan` / `plan-review` / `aggregate` / `approve-*` / `red` / `implement` / `stage` / `apply` / `verify` / `impl-review` / `fix` / `status` / `resume`）は結果 JSON に次の形で `nextSteps` を必ず添えて返す。

```json
{
  "...result payload...": "...",
  "nextSteps": {
    "phase": "staged",
    "inspect": [
      ".mavsdd/features/<feature>/operations/*/operations.json"
    ],
    "nextCommand": "node scripts/cli/mavsdd.mjs apply --feature <feature>",
    "note": null
  }
}
```

- `phase`: 現 phase（`feature-state.json.phase` と一致）
- `inspect[]`: 現 phase で人間が読んで判断すべき `.mavsdd/features/<feature>/` 配下のファイル。glob 表記可
- `nextCommand`: 次に実行する canonical CLI 1 行
- `note`: 条件付き警告（`aggregate.impl=RED` の直後など）。通常は null

skill は CLI 出力をそのまま user に見せる（`disable-model-invocation: true`）ので、`/mavsdd-*` を実行するたびに **"次のコマンド" と "読むべきファイル"** が session に表示される。

#### 0.8.2 README は operator のファイル閲覧 index を兼ねる

`README.md` の "Which `.mavsdd/*` files should humans inspect?" セクションは phase ↔ 確認対象ファイルの公式対応表であり、`nextSteps.inspect[]` と常に一致させる。実装を変更する際は本 plan §0 と README のテーブル両方を更新する。

#### 0.8.3 `.mavsdd/features/<feature>/INDEX.md` 自動再生成契約

operator が `.mavsdd/` 配下のどの json / md を開けばよいか毎回頭で解決しなくて済むよう、state-mutating な全 CLI 実行（`saveState()` / `appendRunMetadata()` の呼び出し口）ごとに **`.mavsdd/features/<feature>/INDEX.md` を自動で全書き替え**する。

**ファイルの中身（必須セクション、この順序で）**:

1. `# <feature>  <phase-emoji> \`<phase>\`` — H1 に現 phase
2. `## Progress` — phase の順序チェックリスト（`[x]` / `[ ] ← 現在` / `[ ]`）
3. `## 👉 Next` — 次に何をするかを 1 文 + 次の CLI コマンド（`nextSteps.nextCommand` と同じ文字列）
4. `**Open**:` — 現 phase で開くべき `.mavsdd/features/<feature>/` 配下ファイルの **Markdown リンク（相対パス）付き箇条書き**。`nextSteps.inspect[]` と 1:1
5. `## Feature` — `goal` / `target` / `verify-command` の 3 行要約（`feature-state.json` から引く）
6. `## Recent events (last 5)` — `run-metadata/events.jsonl` の末尾 5 行を `- YYYY-MM-DDTHH:MM:SSZ \`<event>\` <summary>` 形式で

**契約**:

- INDEX.md は **`nextSteps.inspect[]` と必ず同じファイル集合**を `Open` に並べる（`nextSteps` と UI が乖離しないことが operator の信頼点）
- `phase-emoji` は `initialized=⚪` / `planned=🟡` / `plan_reviewed=🟡` / `plan_approved=🟢` / `red=🔴` / `implementing=🟣` / `staged=🟠` / `applied=🟣` / `verified=🟢` / `impl_reviewed=🟡` / `impl_approved=🟢` / `fix_required=🟠` / `done=✅` / `blocked=🚫` を既定とし、実装は `scripts/lib/mavsdd-core.mjs` の `PHASE_PROGRESS` に集約する
- operator が手動で編集しても **次の CLI 実行で無条件に上書き**される。INDEX.md は生成物、真実の源は `feature-state.json` + `run-metadata/events.jsonl`
- INDEX.md の破損（書き出し失敗）は CLI の非致命エラーとして `events.jsonl` に `"event":"index_write_failed"` を append する（CLI 自体は成功扱い）
- `phase === "done"` のときは `## 👉 Next` を `Feature complete. No further action.` に固定し `Open` は空リスト

**README との関係**:

- README には phase → 開くファイルの公式対応表を記載するが、**operator が暗記する必要は無い** — INDEX.md が毎回差し替えて教える
- README には **"一番先に開くのは `.mavsdd/features/<feature>/INDEX.md`"** と明示する

### 0.9 Claude-only 運用経路（Codex 非依存、`--backend mock`）

`/mavsdd-plan-review` / `/mavsdd-impl-review` **以外**は Codex を必要としない。Codex が未導入 / quota 切れのときは、fish で `verdict.json` を手書きする代わりに **同じ skill に `--backend mock`** を渡す。

```
/mavsdd-plan-review --feature <f> --reviewers 3 --backend mock --verdict GREEN --reason "Codex unavailable" --by "<name>"
/mavsdd-impl-review --feature <f> --reviewers 3 --backend mock --verdict GREEN --reason "Codex unavailable" --by "<name>"
```

効果:

- N 体分の `reviewer-*/verdict.json` を一括生成
- 各 verdict に `meta: {source:"human-mock", reason, reviewedBy, reviewedAt, backend:"mock"}` を埋め込む（audit 可能、codex 経路の verdict と一目で区別できる）
- `run-metadata/events.jsonl` に `provider:"human-mock"` / `kind:"model_invocation"` を append
- phase は real review と同じく `plan_reviewed` / `impl_reviewed` に遷移

この経路でも `aggregate → approve-* → done` は通常通り通る。aggregate が `conditional: true` にならなくても、`approve-*` には `--accept-risk "Codex unavailable: human-mock"` を付けるのを **強く推奨**（`human-approvals.jsonl` に理由が残る）。

### 0.10 Rubric は 3 軸（plan と impl で別軸）

v1 の rubric は適度に単純化:

- **plan review**（`templates/codex-rubric-plan.md`）: `spec_clarity` / `decomposition_soundness` / `risk_coverage` / `team_feasibility`（仕様レビュー軸）
- **impl review**（`templates/codex-rubric-impl.md`）: **`quality` / `efficiency` / `maintainability`**（コードレビュー 3 軸）
  - `quality` = 正しさ・仕様充足・test の実質・security / input validation / hidden behavior
  - `efficiency` = 実行効率・test の wall time 肥大・不要 allocation / I/O
  - `maintainability` = 可読性・将来変更コスト・dead code / 重複 / 命名 / 型の narrow さ / 残骸コメント

同じ軸を繰り返し 5 個に細分化すると reviewer が「軸単位で埋める」癖を作る。3 軸に絞って、その中で具体 finding を切り出させる。

## 1. 目的

本 OSS は、Anthropic の harness engineering 文脈で使える、マルチエージェント型の VSDD 実行基盤を新規リポジトリとして構築する。

既存の `vsdd-claude-code` は単一 Builder + 単一 Adversary を前提にしており、以下を満たさない。

- Planner がマルチエージェント構成そのものを決定すること
- Plan review / implementation review の両方で Codex jury を走らせること
- Claude Code Agent Team を使って implementer / fixer を並列実行すること
- plan、review、team composition、workspace、operations manifest を disk-first に永続化すること
- セッション再起動や reviewer timeout に耐えること

したがって本計画では、既存 OSS を拡張せず、別 OSS `multi-agent-vsdd` を新規作成する。

## 2. ユーザー要求との対応

この計画は、ユーザー要求を次の形で満たす。

- Planner は Claude Code の `opus` alias（2026-04-21 時点で Anthropic API では Claude Opus 4.7）、effort `xhigh` を使い、要件分解、team structure、role、per-unit brief、VSDD artifact を決める
- Plan adversary review は Codex `gpt-5.4`、effort `high` を既定として複数 reviewer で実行する
- 実装は Claude Code の `sonnet` alias（2026-04-21 時点で Anthropic API では Claude Sonnet 4.6）、effort `high` を既定として Agent Team として走らせる。`xhigh` を使う場合は provider / full model name を pin し、resolved model を artifact に残す
- 実装後も同じ Codex jury パターンで adversary review を行う
- findings があれば fix loop を回し、Fixer Team が修正する
- plan / impl の両方で human approval gate を必須にする
- plan file、VSDD spec、all review reports、team composition、runtime ledger、workspace、operations manifest を `.mavsdd/features/<name>/` に保存する

## 3. プロダクト識別子

- リポジトリ名: `multi-agent-vsdd`
- ユーザー向け Skill 名接頭辞: `mavsdd-*`（invoke は `/mavsdd-*`）
- project Skill 配置: `.claude/skills/mavsdd-*/SKILL.md`
- plugin Skill 配置: `<plugin>/skills/mavsdd-*/SKILL.md`
- trusted CLI entrypoint: `node scripts/cli/mavsdd.mjs <subcommand>`
- ランタイム state dir: `.mavsdd/`
- feature 実行単位: `.mavsdd/features/<feature>/`
- methodology: Multi-Agent VSDD

repository slug / user-facing skill slug / trusted CLI slug / runtime slug はすべて `mavsdd` に統一する。手法としては VSDD を明示的に継承する。

v1 の正規 delivery surface は legacy `.claude/commands/` ではなく Skill とする。`/mavsdd-*` という表記は custom command の種別名ではなく、`.claude/skills/mavsdd-*/SKILL.md` に対応する Skill invocation 名を指す。

`mavsdd-*` Skill は v1 ではすべて orchestration entrypoint として扱い、`disable-model-invocation: true` を付けて Claude の自動起動を禁止する。各 Skill の `allowed-tools` は対応する trusted CLI subcommand と最小限の read-only tool に絞る。

### 3.1 作業前提

- Agent Teams は Claude Code `v2.1.32+` かつ `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` を前提とする
- `install.sh` は Agent Teams 利用時に必要な環境変数または `settings.json` 設定例を出力しなければならない
- `README.md` は Agent Teams が experimental / default off であること、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` が必要であること、未設定時は team-dependent flow が fail-closed で止まることを明記しなければならない
- team-dependent な Skill / trusted CLI（少なくとも `implement`, `fix`, `resume` の team branch）は preflight で前提を検証し、未充足なら明示的な error で abort する

## 4. 成果物の定義

v1 の必須成果物は次のとおり。

- `plan.md`
- `specs/behavioral-spec.md`
- `specs/requirements-index.json`
- `specs/verification-architecture.md`
- `specs/test-strategy.md`
- `specs/convergence-checklist.md`
- `team-composition.json`
- `team-composition.patch.json`（temporary orphan unit がある場合）
- `contexts/planner-brief.md`
- `contexts/repo-pointers.md`
- `contexts/unit-<name>.md`
- `contexts/codex-rubric-plan.md`
- `contexts/codex-rubric-impl.md`
- `team-runtime/team-state.json`
- `team-runtime/task-ledger.jsonl`
- `team-runtime/reviewer-jobs.json`
- `traceability/contract-chain.jsonl`
- `traceability/coverage-matrix.json`
- `red/red-phase.log`
- `red/test-matrix.json`
- `red/failing-tests.json`
- `workspace/base/`
- `workspace/repo/`
- `workspace/runtime/<unit>/`
- `workspace/baseline-manifest.json`
- `operations/<unit>/operations.json`
- `verification/summary.json`
- `verification/profile.json`
- `verification/reports/<unit>.md`
- `fixes/orphan/<cluster-id>/resolution.json`（orphan cluster がある場合）
- `reviews/plan/iteration-K/...`
- `reviews/impl/iteration-K/...`
- `implementations/<unit>/status.json`
- `apply-log.jsonl`
- `fix-log.jsonl`
- `human-approvals.jsonl`

## 5. 脅威モデルと安全境界

### 5.1 v1 が防ぐ対象

v1 は次を防ぐ。

- scope drift
- 誤書き込み
- sloppy execution
- 想定外の phase での direct write
- timeout や session restart による state 消失

### 5.2 v1 が防がない対象

v1 は次を防がない。

- 悪意を持って迂回を試みる agent
- 任意コード実行で hook や detector を回避する agent
- OS-level sandbox を前提とする強制分離

これらは v2+ の sandbox 化で扱う。

### 5.3 安全境界

本設計の安全境界は 2 層に分かれる。

1. `hook` による agent-visible tool の制御
2. `trusted CLI` による stage/apply/verify の厳密実装

重要なのは、`Bash("node ...")` で起動した子プロセス内部の書き込みは hook から直接観測できない、という点である。したがって次の方針を採る。

- `Write` / `Edit` / `MultiEdit` / direct shell write は hook で fail-closed に制御する
- `/mavsdd-stage`、`/mavsdd-apply`、`/mavsdd-verify` は `trusted CLI` として扱い、内部の安全性は `scripts/lib/*.mjs` で保証する
- hook は trusted CLI の「内部書き込みを許可する」のではなく、「通常 agent の direct write を禁止する」役目を持つ

## 6. システム全体像

以下で `/mavsdd-*` と書くものは、すべて user-facing Skill 名を表す。Skill 自体は薄い orchestration layer とし、永続化、排他、manifest 検証、traceability 更新、apply invariant は `node scripts/cli/mavsdd.mjs <subcommand>` が担う。

```text
/mavsdd-init
  -> feature tree + rubric templates 初期化

/mavsdd-plan
  -> Planner(opus, xhigh)
  -> behavioral-spec.md
  -> requirements-index.json
  -> verification-architecture.md
  -> test-strategy.md
  -> convergence-checklist.md
  -> traceability seed
  -> planner-brief.md
  -> repo-pointers.md
  -> plan.md
  -> team-composition.json
  -> contexts/unit-*.md

/mavsdd-plan-review
  -> manifest.json 作成
  -> artifact-digests.json 作成
  -> N x Codex reviewer
  -> reviewer-i/raw-response.json
  -> validate -> reviewer-i/verdict.json
  -> .ready

/mavsdd-aggregate --scope plan
  -> aggregate.json

/mavsdd-approve-plan
  -> human gate

/mavsdd-red
  -> requirements/spec/test strategy を failing tests に固定
  -> red/test-matrix.json
  -> red/failing-tests.json
  -> red-phase.log

/mavsdd-implement
  -> workspace/base, workspace/repo, workspace/runtime/<unit> materialize
  -> baseline-manifest.json 作成
  -> team-runtime/team-state.json 初期化
  -> Agent Team fan-out
  -> per-unit green -> refactor
  -> status.json 更新

/mavsdd-stage
  -> workspace/repo vs workspace/base の diff
  -> operations/<unit>/operations.json 作成

/mavsdd-apply
  -> apply-lock 確保
  -> operations を live repo に baseHash 検証付き適用
  -> rollback / apply-log 記録

/mavsdd-verify
  -> verification tier runner 実行
  -> verification/summary.json
  -> verification/reports/<unit>.md
  -> convergence-checklist 更新

/mavsdd-impl-review
  -> manifest.json 作成
  -> artifact-digests.json 作成
  -> N x Codex reviewer
  -> reviewer-i/raw-response.json
  -> validate -> reviewer-i/verdict.json

/mavsdd-aggregate --scope impl
  -> aggregate.json

/mavsdd-approve-impl
  -> GREEN なら done
  -> YELLOW/RED なら fix_required

/mavsdd-fix
  -> findings を non-overlapping cluster に分割
  -> Fixer Team が workspace/repo を再編集
  -> /mavsdd-stage -> /mavsdd-apply -> /mavsdd-verify -> /mavsdd-impl-review(iter N+1)

/mavsdd-resume
  -> .mavsdd canonical state を読み込む
  -> missing reviewer slot / unfinished unit だけを再 spawn
```

## 7. コア設計判断

### 7.1 Shared workspace + immutable baseline

`/mavsdd-implement` は 2 つの repo snapshot を持つ。

- `workspace/base/`: immutable baseline
- `workspace/repo/`: implementer / fixer が触る working copy

これにより、stage は常に `workspace/repo` と `workspace/base` を比較できる。live repo との差分ではないため、materialize 後に live repo が変化しても stage 時点で誤って `baseHash` を取り直すことがない。

### 7.2 baseHash の基準時点

`baseHash` は必ず materialize 時の `workspace/base/` から計算する。`/mavsdd-stage` 実行時の live repo からは取らない。

これにより、materialize 後に別プロセスが live repo を変えても、`/mavsdd-apply` の baseHash 検証で確実に conflict になる。

### 7.3 trusted CLI

次のコマンドは trusted CLI とする。

- `node scripts/cli/mavsdd.mjs init`
- `node scripts/cli/mavsdd.mjs plan`
- `node scripts/cli/mavsdd.mjs plan-review`
- `node scripts/cli/mavsdd.mjs aggregate`
- `node scripts/cli/mavsdd.mjs approve-plan`
- `node scripts/cli/mavsdd.mjs red`
- `node scripts/cli/mavsdd.mjs approve-orphan`
- `node scripts/cli/mavsdd.mjs implement`
- `node scripts/cli/mavsdd.mjs stage`
- `node scripts/cli/mavsdd.mjs apply`
- `node scripts/cli/mavsdd.mjs verify`
- `node scripts/cli/mavsdd.mjs impl-review`
- `node scripts/cli/mavsdd.mjs approve-impl`
- `node scripts/cli/mavsdd.mjs fix`
- `node scripts/cli/mavsdd.mjs status`
- `node scripts/cli/mavsdd.mjs resume`

各 `mavsdd-*` Skill は原則 1:1 で対応する trusted CLI subcommand を呼ぶ薄い wrapper とする。内部ファイル操作の安全性は hook ではなく、CLI 実装と library test で保証する。

### 7.4 apply-lock の役割

`.mavsdd/.apply-lock` は認可 token ではない。役割は次の 2 つだけ。

- 同時 apply を防ぐ排他
- crash 後の復旧情報の保持

lock には `pid`, `startedAt`, `feature`, `scope`, `status` を保存する。hook は lock を参照して direct write の phase を厳しくし得るが、apply-engine 内部の write を認可するためには使わない。

### 7.5 `.mavsdd` を正本にする

Claude Code Agent Teams は 2026-04-21 時点で experimental であり、in-process teammate の `/resume` 復元に既知の制限がある。したがって本設計では、`~/.claude/teams/*` と `~/.claude/tasks/*` は runtime mirror とみなし、正本にはしない。

- 正本: `.mavsdd/features/<feature>/team-runtime/team-state.json`
- 実行ログ: `.mavsdd/features/<feature>/team-runtime/task-ledger.jsonl`
- review 再開点: `.mavsdd/features/<feature>/team-runtime/reviewer-jobs.json`

`/mavsdd-plan-review` と `/mavsdd-impl-review` は reviewer slot の spawn / validate / timeout / retry ごとに `reviewer-jobs.json` を更新する。`/mavsdd-resume` は上記 3 つを読み、native team runtime を復元するのではなく、lead が missing reviewer slot と unfinished unit を再 spawn する。これにより、セッション再起動耐性は process-level ではなく artifact-level に保証する。

## 8. エージェント構成

### 8.1 Planner

- model: `opus` alias
- effort: `xhigh`
- role: request を plan、team composition、unit briefs、behavioral spec、verification architecture に落とす

### 8.2 Plan / Impl Reviewers

- model: `gpt-5.4`
- effort: `high`
- count: default `3`, clamp `[1, 5]`
- invocation path: trusted CLI（`/mavsdd-plan-review` / `/mavsdd-impl-review`）が `manifest.artifactsToReview.source` を Claude Code セッション側で先読し、artifact 内容を Codex prompt payload に埋め込んで外部 Codex adapter に渡す。`codex-companion.mjs` は current candidate であり、Phase 0 spike 完了後に実 interface へ固定する
- read audit: `read-set.jsonl` と `artifact-digests.json` は trusted CLI の preload read が直接記録する
- role: adversarial review, evaluation, judgement, findings

### 8.3 Implementers

- model: `sonnet` alias
- effort: `high`
- execution: Claude Code Agent Team
- role: assigned unit のみ担当、workspace/repo 内の許可 scope だけ編集し、red gate を前提に green -> refactor と unit verification evidence を残す

### 8.4 Fixers

- model: `sonnet` alias
- effort: `high`
- execution: Claude Code Agent Team
- role: cluster 単位の findings を修正し、cluster-derived scope だけを編集する

Agent Teams の exact primitive 名と引数契約は、この時点では概念ラベルとして記述している。`TeamCreate`, task assignment, teammate messaging などの実インターフェースは `spike-team-create.md` 後に確定し、§10, §11, §22 の仮称を実 API 名へ置換する。

### 8.5 Aggregator

- runtime: pure CLI / library (`aggregate.mjs`)
- determinism: 入力 manifest、artifact digests、validated verdicts、trusted CLI preload read-set が同じなら必ず同じ `aggregate.json` を返す
- role: canonical verdicts を読み deterministic に `aggregate.json` を生成し、recommended action を決める

### 8.6 model resolution policy

- alias は requested model として扱い、実行時の `resolvedModel`, `provider`, `requestedEffort`, `resolvedEffort`, `runtimeVersion` を disk に残す
- model を実行する Skills は `config.json.modelPolicy` を preflight で検証し、`provider` / `resolvedModel` / `resolvedEffort` が許可条件を満たさない場合は spawn 前に fail-closed で abort する
- fail-closed で止めた場合も `run-metadata/` には `status = "rejected"`, `policyDecision = "deny"`, `policyReason` を残し、phase は進めない
- `sonnet` alias は 2026-04-21 時点の Anthropic API では Sonnet 4.6 を指すため、default effort は `high` とする
- implementer / fixer で `xhigh` を使いたい場合は full model name または provider override を明示し、run metadata に pin 情報を残す

### 8.7 Codex reviewer invocation model

採用方式は A とする。

- trusted CLI（`/mavsdd-plan-review` / `/mavsdd-impl-review`）が current manifest の `artifactsToReview.source` を Claude Code セッション側で先読する
- preload した artifact 内容は reviewer slot ごとの prompt payload に埋め込み、外部 Codex adapter に渡す。現時点では `Task(codex:codex-rescue)` -> `codex-companion.mjs` を仮ラベルとして置く
- Codex reviewer 本体は repo 上のファイル I/O を行わず、受け取った artifact snapshot に対して純粋に推論し、structured JSON response だけを返す
- `read-set.jsonl` と `artifact-digests.json` は trusted CLI の preload read を正本として記録する。coverage は「Codex が何を読んだか」ではなく、「trusted CLI が reviewer に渡す前提 artifact をすべて先読できたか」で判定する
- reviewer-jobs.json / manifest snapshot / aggregate の source of truth を Claude Code 側に寄せられるため、resume と監査の整合が最も高い
- adapter 名、起動 method、payload schema、timeout / retry 契約は `spike-codex-parallel.md` の結果で確定し、その後 §8.7 の仮称を実インターフェースへ置換する

採用しなかった方式:

- 方式 B: `codex-companion.mjs` 自身に read-set logging を持たせると、監査正本が Claude Code hook 面から外れ、review resume / phase gate / audit trail が二重化する
- 方式 C: adversary を Anthropic reviewer に置き換えると監査は単純になるが、Codex jury を使うという要件から外れる

## 9. ランタイム構造

```text
.mavsdd/
├── config.json
├── active.json
├── .apply-lock
└── features/<feature>/
    ├── state.json
    ├── plan.md
    ├── specs/
    │   ├── behavioral-spec.md
    │   ├── verification-architecture.md
    │   ├── test-strategy.md
    │   └── convergence-checklist.md
    ├── team-composition.json
    ├── team-composition.patch.json
    ├── contexts/
    │   ├── planner-brief.md
    │   ├── repo-pointers.md
    │   ├── codex-rubric-plan.md
    │   ├── codex-rubric-impl.md
    │   └── unit-<name>.md
    ├── team-runtime/
    │   ├── team-state.json
    │   ├── task-ledger.jsonl
    │   └── reviewer-jobs.json
    ├── traceability/
    │   ├── contract-chain.jsonl
    │   └── coverage-matrix.json
    ├── red/
    │   ├── red-phase.log
    │   ├── test-matrix.json
    │   └── failing-tests.json
    ├── run-metadata/
    │   ├── plan.json
    │   ├── implement/<unit>.json
    │   ├── fix/<cluster-id>.json
    │   ├── review/plan-iteration-K.json
    │   ├── review/impl-iteration-K.json
    │   └── aggregate/<scope>-iteration-K.json
    ├── workspace/
    │   ├── base/
    │   ├── repo/
    │   ├── runtime/<unit>/
    │   └── baseline-manifest.json
    ├── operations/
    │   └── <unit>/operations.json
    ├── verification/
    │   ├── profile.json
    │   ├── summary.json
    │   └── reports/<unit>.md
    ├── fixes/
    │   └── orphan/<cluster-id>/resolution.json
    ├── reviews/
    │   ├── plan/iteration-K/
    │   │   ├── manifest.json
    │   │   ├── artifact-digests.json
    │   │   ├── reviewer-i/read-set.jsonl
    │   │   ├── reviewer-i/raw-response.json
    │   │   ├── reviewer-i/verdict.json
    │   │   ├── reviewer-i/validation-errors.json
    │   │   ├── .ready
    │   │   └── aggregate.json
    │   └── impl/iteration-K/
    │       ├── manifest.json
    │       ├── artifact-digests.json
    │       ├── reviewer-i/read-set.jsonl
    │       ├── reviewer-i/raw-response.json
    │       ├── reviewer-i/verdict.json
    │       ├── reviewer-i/validation-errors.json
    │       ├── .ready
    │       └── aggregate.json
    ├── implementations/
    │   └── <unit>/status.json
    ├── apply-log.jsonl
    ├── fix-log.jsonl
    └── human-approvals.jsonl
```

## 10. 生成責務

artifact の生成責務を曖昧にしない。

### 10.1 `/mavsdd-init`

生成するもの:

- `state.json`
- `config.json`
- `active.json`
- feature tree の空ディレクトリ
- `specs/convergence-checklist.md`
- `contexts/codex-rubric-plan.md`
- `contexts/codex-rubric-impl.md`
- `traceability/` の空ディレクトリ
- `red/` の空ディレクトリ

### 10.2 `/mavsdd-plan`

生成するもの:

- `specs/behavioral-spec.md`
- `specs/requirements-index.json`
- `specs/verification-architecture.md`
- `specs/test-strategy.md`
- `contexts/planner-brief.md`
- `contexts/repo-pointers.md`
- `plan.md`
- `team-composition.json`
- `contexts/unit-<name>.md`
- `traceability/coverage-matrix.json`
- `traceability/contract-chain.jsonl`
- `verification/profile.json`

### 10.3 `/mavsdd-red`

生成するもの:

- `red/test-matrix.json`
- `red/failing-tests.json`
- `red/red-phase.log`
- `traceability/contract-chain.jsonl` の red gate entries

### 10.4 `/mavsdd-implement`

生成するもの:

- `workspace/base/`
- `workspace/repo/`
- `workspace/runtime/<unit>/`
- `workspace/baseline-manifest.json`
- `team-runtime/team-state.json`
- `team-runtime/task-ledger.jsonl`
- `implementations/<unit>/status.json`
- `traceability/contract-chain.jsonl` の implementation status / touched-scope entries
- `team-composition.patch.json` があれば load

### 10.5 `/mavsdd-stage`

生成するもの:

- `operations/<unit>/operations.json`
- `traceability/contract-chain.jsonl` の `unit` -> `operations/<unit>/operations.json` entries

### 10.6 `/mavsdd-verify`

生成するもの:

- `verification/summary.json`
- `verification/reports/<unit>.md`
- `specs/convergence-checklist.md` の更新
- `traceability/contract-chain.jsonl` の verification evidence / verdict entries
- `fixes/orphan/<cluster-id>/resolution.json` があれば参照

### 10.7 `/mavsdd-fix`

生成するもの:

- `fixes/orphan/<cluster-id>/resolution.json`（orphan triage がある場合）
- `team-composition.patch.json`（temporary orphan unit を承認した場合）
- `contexts/unit-<name>.md`（temporary orphan unit を追加した場合）
- `fix-log.jsonl`
- `traceability/contract-chain.jsonl` の finding resolution / orphan resolution entries

### 10.8 `/mavsdd-plan-review` / `/mavsdd-impl-review`

生成するもの:

- `reviews/.../manifest.json`
- `reviews/.../artifact-digests.json`
- `reviews/.../reviewer-i/read-set.jsonl`
- `reviews/.../reviewer-i/raw-response.json`
- `reviews/.../reviewer-i/verdict.json`
- `reviews/.../reviewer-i/validation-errors.json`
- `.ready`
- `team-runtime/reviewer-jobs.json` の初期化 / 更新
- `traceability/contract-chain.jsonl` の `FIND-*` provenance / route entries（trusted CLI が valid verdict を promote した後に append）

### 10.9 `/mavsdd-aggregate`

生成するもの:

- `aggregate.json`
- `run-metadata/aggregate/<scope>-iteration-K.json`（deterministic execution record）

### 10.10 `/mavsdd-approve-plan` / `/mavsdd-approve-impl` / `/mavsdd-approve-orphan`

生成するもの:

- `human-approvals.jsonl`
- `human-approvals.jsonl` の各 entry は `approvalId`, `approvalKind`, `phase`, `iteration`, `snapshotId`, `manifestHash`, `aggregateHash`, `approvedBy`, `verdict`, `reason`, `createdAt` を持つ
- `temporary_orphan_unit` の場合は `approvalId` を発行し、`team-composition.patch.json.approvalRef` から参照できるようにする

### 10.11 model invocation metadata

model を実行するすべての Skills（`/mavsdd-plan`, `/mavsdd-red`, `/mavsdd-plan-review`, `/mavsdd-implement`, `/mavsdd-fix`, `/mavsdd-impl-review`）は `run-metadata/` 配下に append-only record を残す。`/mavsdd-aggregate` は pure CLI / library なので model invocation metadata ではなく deterministic execution record を残す。

最低限の fields は次とする。

- `kind`
- `scope`
- `jobId`
- `snapshotId`
- `attemptKey`
- `requestedModel`
- `resolvedModel`
- `provider`
- `requestedEffort`
- `resolvedEffort`
- `runtimeVersion`
- `promptPayloadHash`
- `status`
- `policyDecision`
- `policyReason`
- `startedAt`
- `completedAt`
- `responseIds` または `sessionIds`
- `inputTokens`
- `outputTokens`
- `costUsd`
- `inputArtifacts`
- `outputArtifacts`

### 10.12 canonical runtime schema

feature runtime の正規 field 名は `phase` とする。`state.json` では `state` を使わない。`implementations/<unit>/status.json` の `state` は unit-local status であり、feature-level phase とは別物として扱う。

`state.json`

```json
{
  "schemaVersion": "1.0",
  "feature": "invoice-pdf-export",
  "phase": "red_pending",
  "planIteration": 1,
  "redIteration": 1,
  "implIteration": 0,
  "fixIteration": 0,
  "baselineId": null,
  "updatedAt": "2026-04-21T10:00:00Z"
}
```

`config.json`

```json
{
  "schemaVersion": "1.0",
  "juryCount": 3,
  "juryTimeoutSec": 900,
  "maxFixIterations": 3,
  "maxReviewerRetries": 2,
  "maxFeatureTokenBudget": 4000000,
  "maxReviewTokenBudget": 1200000,
  "artifactRetentionDays": 30,
  "workspaceGcDays": 7,
  "verificationProfileRef": ".mavsdd/features/invoice-pdf-export/verification/profile.json",
  "reviewPolicy": {
    "mode": "fail-closed-adversarial-gate",
    "quorumRatio": "2/3"
  },
  "modelPolicy": {
    "planner": {
      "provider": "anthropic",
      "requestedModel": "opus",
      "requestedEffort": "xhigh"
    },
    "reviewer": {
      "provider": "openai-responses",
      "requestedModel": "gpt-5.4",
      "requestedEffort": "high"
    },
    "implementer": {
      "provider": "anthropic",
      "requestedModel": "sonnet",
      "requestedEffort": "high"
    },
    "fixer": {
      "provider": "anthropic",
      "requestedModel": "sonnet",
      "requestedEffort": "high"
    }
  }
}
```

`active.json`

```json
{
  "schemaVersion": "1.0",
  "activeFeature": "invoice-pdf-export",
  "phase": "red_pending",
  "updatedAt": "2026-04-21T10:00:00Z"
}
```

`team-runtime/reviewer-jobs.json`

```json
{
  "schemaVersion": "1.0",
  "feature": "invoice-pdf-export",
  "scope": "plan",
  "iteration": 1,
  "snapshotId": "plan-iteration-1-snapshot-a1b2c3d4",
  "updatedAt": "2026-04-21T10:05:00Z",
  "jobs": [
    {
      "jobId": "plan-1-reviewer-1",
      "reviewerId": "reviewer-1",
      "status": "running",
      "attempt": 1,
      "attemptKey": "plan-1-reviewer-1-attempt-1",
      "manifestPath": ".mavsdd/features/invoice-pdf-export/reviews/plan/iteration-1/manifest.json",
      "artifactDigestsPath": ".mavsdd/features/invoice-pdf-export/reviews/plan/iteration-1/artifact-digests.json",
      "readSetPath": ".mavsdd/features/invoice-pdf-export/reviews/plan/iteration-1/reviewer-1/read-set.jsonl",
      "rawResponsePath": ".mavsdd/features/invoice-pdf-export/reviews/plan/iteration-1/reviewer-1/raw-response.json",
      "verdictPath": ".mavsdd/features/invoice-pdf-export/reviews/plan/iteration-1/reviewer-1/verdict.json",
      "promptPayloadHash": "sha256:...",
      "lastHeartbeatAt": "2026-04-21T10:05:20Z"
    }
  ]
}
```

## 11. `team-composition.json` 仕様

```json
{
  "schemaVersion": "1.0",
  "feature": "invoice-pdf-export",
  "teamName": "mavsdd-invoice-pdf-export",
  "units": [
    {
      "name": "schema",
      "role": "data-modeler",
      "scope": "Add migration and shared invoice types.",
      "requirements": ["REQ-001", "REQ-002"],
      "depends_on": [],
      "verificationTier": "tier1",
      "writePaths": ["db/migrations/"],
      "writeFiles": ["src/types/invoice.ts"],
      "readPaths": ["specs/"],
      "readFiles": [],
      "briefPath": ".mavsdd/features/invoice-pdf-export/contexts/unit-schema.md"
    },
    {
      "name": "renderer",
      "role": "implementer",
      "scope": "Render invoice PDF.",
      "requirements": ["REQ-003", "REQ-004"],
      "depends_on": ["schema"],
      "verificationTier": "tier2",
      "writePaths": ["src/pdf/", "tests/pdf/"],
      "writeFiles": [],
      "readPaths": ["src/types/"],
      "readFiles": [],
      "briefPath": ".mavsdd/features/invoice-pdf-export/contexts/unit-renderer.md"
    }
  ],
  "executionStrategy": "dependency-ordered",
  "maxParallel": 2
}
```

### 11.1 hard validation

`roster.mjs` は次を強制する。

- role は `config/roles.json` の member
- `requirements[]` は `specs/requirements-index.json` の `REQ-*` を参照し、全 `REQ-*` が少なくとも 1 unit に紐付く
- `writePaths` は相対 path、`..` 禁止、`**` 禁止、末尾 `/` 必須
- `writeFiles` は相対 file path、`..` 禁止
- `verificationTier` は `tier0|tier1|tier2|tier3`
- 各 write target は role の `allowedWritePaths` 配下
- unit 間の `writePaths` と `writeFiles` は prefix / exact match で非重複
- `depends_on` に cycle が無い
- `maxParallel` は `[1, 5]`
- `briefPath` は feature 名と unit 名に一致し、実ファイルが存在する
- `/mavsdd-fix` が生成する fixer cluster は static role ではなく cluster manifest から write scope を導出する
- `team-composition.patch.json` がある場合、overlay 後の effective team composition も同じ validation を満たさなければならない

### 11.2 traceability 契約

`traceability/coverage-matrix.json` と `traceability/contract-chain.jsonl` は、少なくとも次の流れを追跡できなければならない。

- `REQ-*` -> `PROP-*`
- `REQ-*` -> `TEST-*`
- `REQ-*` -> `unit`
- `TEST-*` -> red gate evidence
- `unit` -> `operations/<unit>/operations.json`
- `FIND-*` -> route (`spec|test|impl|verification|review_meta`)

`review_meta` に分類された finding は fix cluster の入力に入れない。`coverage_incomplete` は必ず `review_meta` とする。

更新責務は Skills ごとに明示する。

- `/mavsdd-plan`: `REQ-*`, `PROP-*`, `TEST-*`, `unit` の基底 edge を append する
- `/mavsdd-red`: `TEST-*` -> red gate evidence を append する
- `/mavsdd-implement`: unit の implementation status と touched scope の evidence を append する
- `/mavsdd-stage`: `unit` -> `operations/<unit>/operations.json` を append する
- `/mavsdd-verify`: verification summary / report に対応する evidence edge を append する
- `/mavsdd-plan-review` / `/mavsdd-impl-review`: trusted CLI が valid verdict を promote した後に `FIND-*` の provenance, route, snapshot binding を append する
- `/mavsdd-fix`: `FIND-*` -> resolution / orphan resolution を append する

### 11.3 verification tier 契約

`verificationTier` は unit ごとの hardening 深度を表す。各 tier の pass 条件は次のとおり。

- `tier0`
  - 必須: unit test、lint/typecheck のうち unit に関連する最小セット
  - artifact: `verification/reports/<unit>.md` に executed commands、exit code、主要ログ要約
  - pass: 必須コマンドがすべて exit code `0`
- `tier1`
  - 必須: `tier0` + integration smoke または property/contract test のどちらか
  - artifact: `tier0` artifact + 追加 test 種別の evidence
  - pass: `tier0` を満たし、追加テストも exit code `0`
- `tier2`
  - 必須: `tier1` + fuzz/stress/regression/differential のいずれか 1 つ以上
  - artifact: seed、iteration 数、失敗 0 件または許容閾値内であること
  - pass: `tier1` を満たし、hardening テストが profile で定めた閾値を満たす
- `tier3`
  - 必須: `tier2` + project-defined formal/hardening profile
  - artifact: `specs/verification-architecture.md` に列挙した追加検証の結果、または unsupported なら waiver
  - pass: `tier2` を満たし、追加検証成功。未対応言語・未対応ツールでは `specs/convergence-checklist.md` に waiver を明記し、人間承認なしでは pass 扱いにしない

`/mavsdd-verify --tier auto` は、変更された unit 群の `verificationTier` の最大値を `effectiveTier` として選ぶ。明示 tier 指定は、対象 unit の最大 tier 未満に下げてはならない。

`verification/summary.json` は少なくとも `requestedTier`, `effectiveTier`, `unitResults`, `overallVerdict`, `failedUnits`, `generatedAt` を持つ。required artifact 欠落、必須コマンド失敗、waiver 未承認のいずれかがあれば `overallVerdict = "FAIL"` とする。

### 11.4 verification profile 設定

`verification/profile.json` は feature ごとの検証ランナー設定の正本とする。少なくとも次を持つ。

- `schemaVersion`
- `language`
- `tierCommands.tier0[]`
- `tierCommands.tier1[]`
- `tierCommands.tier2[]`
- `tierCommands.tier3[]`
- `waiverPolicy`

`/mavsdd-verify` は `verification/profile.json` を必ず参照し、profile に存在しない tier command は実行してはならない。

## 12. `config/roles.json` 仕様

```json
{
  "schemaVersion": "1.0",
  "roles": {
    "data-modeler": {
      "subagent_type": "mavsdd-implementer",
      "model": "sonnet",
      "effort": "high",
      "allowedWritePaths": ["db/", "src/types/"]
    },
    "implementer": {
      "subagent_type": "mavsdd-implementer",
      "model": "sonnet",
      "effort": "high",
      "allowedWritePaths": ["src/", "tests/"]
    },
    "http-endpoint": {
      "subagent_type": "mavsdd-implementer",
      "model": "sonnet",
      "effort": "high",
      "allowedWritePaths": ["src/http/", "src/api/", "tests/http/"]
    },
    "test-engineer": {
      "subagent_type": "mavsdd-implementer",
      "model": "sonnet",
      "effort": "high",
      "allowedWritePaths": ["tests/"]
    },
    "fixer": {
      "subagent_type": "mavsdd-fixer",
      "model": "sonnet",
      "effort": "high",
      "scopePolicy": "cluster-derived"
    }
  }
}
```

## 13. Workspace モデル

### 13.1 materialize

`/mavsdd-implement` は live repo から次を作る。

1. `workspace/base/` に repo snapshot を materialize
2. `workspace/repo/` を `workspace/base/` から作る
3. `workspace/runtime/<unit>/` を作る
4. `baseline-manifest.json` を生成する

`baseline-manifest.json` は少なくとも次を持つ。

- `baselineId`
- `repoHead`
- `generatedAt`
- `files[path] = { hash, mode }`

### 13.2 implementer の作業領域

implementer / fixer は次にだけ書ける。

- `workspace/repo/<declared repo scope>`
- `workspace/runtime/<unit>/**`
- `implementations/<unit>/status.json`
- `fixes/orphan/<cluster-id>/resolution.json`
- `team-composition.patch.json`（human-approved temporary orphan unit を記録するときだけ）

テストの一時出力は `workspace/runtime/<unit>/` に逃がす。repo tree に生成物を書きたい場合は、その path が unit の `writePaths` / `writeFiles` に明示されていなければならない。

### 13.3 status.json

```json
{
  "state": "done",
  "unit": "renderer",
  "redGateSatisfied": true,
  "greenRefactorCompleted": true,
  "testsRan": true,
  "redPhaseRef": ".mavsdd/features/invoice-pdf-export/red/red-phase.log",
  "requirements": ["REQ-003", "REQ-004"],
  "testCommand": "cd .mavsdd/features/invoice-pdf-export/workspace/repo && pnpm test --filter pdf",
  "testExitCode": 0,
  "verificationTier": "tier2",
  "verificationState": "passed",
  "verificationCommand": "cd .mavsdd/features/invoice-pdf-export/workspace/repo && pnpm test:hardening --filter pdf",
  "verificationExitCode": 0,
  "baselineId": "base-20260421-100000",
  "completedAt": "2026-04-21T10:00:00Z"
}
```

## 14. `safeCanonical` 仕様

新規ファイルでも動く path 正規化を使う。

```js
function safeCanonical(rootAbs, relPath) {
  rejectIfAbsolute(relPath)
  rejectIfContainsDotDot(relPath)
  rejectIfContainsNul(relPath)

  const candidateAbs = path.resolve(rootAbs, relPath)
  const ancestor = nearestExistingAncestor(candidateAbs)
  const realAncestor = fs.realpathSync.native(ancestor)

  ensureInsideRoot(realAncestor, rootAbs)
  ensureNoSymlinkOnExistingPath(rootAbs, ancestor)

  const suffix = path.relative(ancestor, candidateAbs)
  const normalized = path.join(realAncestor, suffix)
  ensureInsideRoot(normalized, rootAbs)
  return normalized
}
```

ポイントは次のとおり。

- target file が未作成でも落ちない
- 既存親ディレクトリまで realpath 解決する
- 既存 path component に symlink があれば reject
- repo root / workspace root の外へ出る candidate は reject

## 15. Operations manifest

`/mavsdd-stage` は `workspace/repo/` と `workspace/base/` を比較し、unit ごとの `operations.json` を作る。

### 15.1 shape

```json
{
  "schemaVersion": "1.0",
  "feature": "invoice-pdf-export",
  "unit": "renderer",
  "baselineId": "base-20260421-100000",
  "generatedAt": "2026-04-21T10:10:00Z",
  "ops": [
    {
      "op": "overwrite",
      "path": "src/pdf/render.ts",
      "baseHash": "sha256:...",
      "contentHash": "sha256:..."
    },
    {
      "op": "add",
      "path": "tests/pdf/render.test.ts",
      "contentHash": "sha256:..."
    },
    {
      "op": "delete",
      "path": "src/pdf/legacy.ts",
      "baseHash": "sha256:..."
    },
    {
      "op": "rename",
      "from": "src/pdf/old.ts",
      "to": "src/pdf/new.ts",
      "baseHash": "sha256:..."
    },
    {
      "op": "chmod",
      "path": "scripts/generate-pdf.sh",
      "baseHash": "sha256:...",
      "mode": "755"
    }
  ]
}
```

### 15.2 stage 時の検証

`diff-to-operations.mjs` は次を実行する。

- diff 対象は `workspace/repo/` vs `workspace/base/`
- `baseHash` は `baseline-manifest.json` から取得
- effective scope は `team-composition.json` に `team-composition.patch.json` があれば overlay したものを使う
- 各 op の path は effective scope 上の unit `writePaths` / `writeFiles` scope 内でなければ reject
- unit 間で `path`, `from`, `to` の重複があれば reject
- `add` で baseline に存在した path は invalid
- `delete` / `overwrite` / `rename` は baseline に該当 file が無ければ invalid

## 16. Apply engine

`/mavsdd-apply` は trusted CLI として動作し、`apply-engine.mjs` がすべての invariant を持つ。

### 16.1 apply 手順

1. `.mavsdd/.apply-lock` を作成し、同時 apply を禁止
2. 全 unit の `operations.json` を読み込み、`applyTxnId = hash(feature + baselineId + opDigests)` を計算する
3. `apply-log.jsonl` に同じ `applyTxnId` が `committed` で存在すれば idempotent success として終了する
4. `baselineId` が feature 内で一致することを確認
5. 各 op について live repo の現在値を読む
6. `baseHash` 不一致なら即 abort
7. 同じ `applyTxnId` の partial record があれば逆順 rollback してから再試行する
8. 全 op を atomic に適用
9. `apply-log.jsonl` に `applyTxnId` 付きで結果を記録
10. `state.json.phase = impl_applied`
11. lock を削除

### 16.2 lock shape

```json
{
  "feature": "invoice-pdf-export",
  "pid": 12345,
  "applyTxnId": "apply-a1b2c3d4",
  "status": "running",
  "startedAt": "2026-04-21T10:20:00Z"
}
```

### 16.3 apply と hook の責務分離

`apply-engine.mjs` の内部 write は hook では観測できない可能性がある。したがって、apply の安全性は hook に依存しない。

- hook の責務: agent の direct repo write を deny すること
- apply-engine の責務: baseHash, rollback, atomicity, conflict detection を保証すること

## 17. Review pipeline

### 17.1 reviewer prompt 契約

Codex reviewer には次を強制する。

- model は既定 `gpt-5.4`、effort は既定 `high`
- reviewer は trusted CLI が生成した frozen snapshot payload だけを読む
- reviewer 自身は repo file I/O を行わない
- reviewer 自身は repo file write を行わない
- `codex-companion.mjs` は structured JSON を stdout または API response として返すだけにする
- trusted CLI が `raw-response.json` を保存し、schema validate 後に `verdict.json` を atomically 書く
- canonical coverage evidence は trusted CLI preload が生成する `reviewer-i/read-set.jsonl` と `artifact-digests.json`
- report は `model`, `resolvedModel`, `provider`, `snapshotId`, `promptPayloadHash`, `summary`, `evaluation`, `judgement`, `recommendedAction`, `confidence`, `findings` を必須とする

### 17.1.1 reviewer report schema

```json
{
  "schemaVersion": "1.0",
  "scope": "plan",
  "iteration": 1,
  "snapshotId": "plan-iteration-1-snapshot-a1b2c3d4",
  "reviewerId": "reviewer-1",
  "model": "gpt-5.4",
  "resolvedModel": "gpt-5.4",
  "provider": "openai-responses",
  "effort": "high",
  "promptPayloadHash": "sha256:...",
  "verdict": "YELLOW",
  "summary": "Resume strategy is now explicit but requires spike validation.",
  "evaluation": {
    "architecture": 0.88,
    "testability": 0.84,
    "operability": 0.72,
    "evidencePaths": [
      "/abs/path/.mavsdd/features/invoice-pdf-export/plan.md"
    ]
  },
  "judgement": {
    "label": "YELLOW",
    "reason": "Non-blocking gaps remain before implementation."
  },
  "recommendedAction": "revise_then_re-review",
  "confidence": "high",
  "readSetProducer": "trusted-cli-preload",
  "readSetRef": ".mavsdd/features/invoice-pdf-export/reviews/plan/iteration-1/reviewer-1/read-set.jsonl",
  "artifactDigestsRef": ".mavsdd/features/invoice-pdf-export/reviews/plan/iteration-1/artifact-digests.json",
  "findings": []
}
```

各 finding は少なくとも `findingId`, `severity`, `blocking`, `category`, `routeTo`, `filePath`, `lineRange`, `description`, `suggestion` を持つ。

### 17.1.2 coverage evidence

review phase 中の canonical read 監査は hook ではなく trusted CLI 自身が持つ。

- `/mavsdd-plan-review` / `/mavsdd-impl-review` は manifest 作成時に `artifactsToReview.source` の absolute path と digest を `artifact-digests.json` に固定する
- 同じ preload で reviewer slot ごとの `read-set.jsonl` に `timestamp`, `snapshotId`, `jobId`, `path`, `digest` を append する
- `codex-companion.mjs` の内部 `fs.readFile` は設計上禁止し、coverage 判定にも使わない
- hook-based `Read` log を持つ場合でも診断用に留め、canonical evidence には使わない
- `read-set.jsonl` が存在しない reviewer、または trusted CLI が required artifacts を先読できていない reviewer は quorum 集計から除外する

### 17.2 plan review artifacts

plan review の `manifest.artifactsToReview.source` は固定で次を含む。

- `plan.md`
- `specs/behavioral-spec.md`
- `specs/requirements-index.json`
- `specs/verification-architecture.md`
- `specs/test-strategy.md`
- `specs/convergence-checklist.md`
- `traceability/coverage-matrix.json`
- `traceability/contract-chain.jsonl`
- `verification/profile.json`
- `team-composition.json`
- `run-metadata/plan.json`
- `contexts/planner-brief.md`
- `contexts/repo-pointers.md`
- `contexts/codex-rubric-plan.md`
- `contexts/unit-*.md`

### 17.3 impl review artifacts

impl review の `manifest.artifactsToReview.source` は固定で次を含む。

- 全 `operations/<unit>/operations.json`
- 全 op が touch する file paths
- 各 unit の `readPaths` / `readFiles` 展開結果
- `red/red-phase.log`
- `red/test-matrix.json`
- `red/failing-tests.json`
- `verification/profile.json`
- `verification/summary.json`
- `verification/reports/<unit>.md`
- 全 `implementations/<unit>/status.json`
- `plan.md`
- `specs/behavioral-spec.md`
- `specs/requirements-index.json`
- `specs/verification-architecture.md`
- `specs/test-strategy.md`
- `specs/convergence-checklist.md`
- `traceability/coverage-matrix.json`
- `traceability/contract-chain.jsonl`
- `team-composition.json`
- `team-composition.patch.json`（temporary orphan unit がある場合）
- `fixes/orphan/<cluster-id>/resolution.json`（orphan triage がある場合）
- `run-metadata/red/*.json`
- `run-metadata/implement/*.json`
- `run-metadata/fix/*.json`（存在すれば）
- `contexts/codex-rubric-impl.md`

### 17.4 snapshot 固定と idempotency

- manifest は review 開始時に snapshot し、その iteration 中は動かさない
- snapshot の正本は `manifest.json.snapshotId` と `artifact-digests.json`
- reviewer slot ごとに `jobId`, `attemptKey`, `promptPayloadHash` を保存する
- 同じ `snapshotId` に対して valid `verdict.json` が存在する slot は再 spawn しない
- artifact 内容が 1 byte でも変わった場合は同 iteration を継続せず、新しい iteration を作る

## 18. Verdict normalization

`mavsdd-review-finalize.mjs` は次を行う。

1. `reviewer-i/raw-response.json` を読み込む
2. schema, scope, iteration, snapshotId, reviewerId, model, resolvedModel, provider, verdict, summary, evaluation, judgement, recommendedAction, confidence, promptPayloadHash を検証し、`judgement.label === verdict` を強制する
3. 検証失敗なら `reviewer-i/validation-errors.json` を残し、`verdict.json` は書かない
4. 検証成功なら `reviewer-i/verdict.json` を atomic write する
5. 同 iteration の全 slot で valid `verdict.json` が揃い、かつ `snapshotId` が一致したら `.ready` を touch する

reviewer には repo write capability を与えない。validation と final write は常に trusted CLI が行う。

## 19. Aggregation

`/mavsdd-aggregate` は model を使わず、`aggregate.mjs` が deterministic に verdict を計算する。

```js
function aggregate(manifest, promotedVerdicts, readSets, now) {
  const normalized = promotedVerdicts
    .filter(v => v.schemaValid && v.snapshotId === manifest.snapshotId)
    .map(v => normalizeCoverage(v, readSets[v.reviewerId], manifest.artifactsToReview.source))

  const covered = normalized.filter(v => v.coverageComplete)
  const coverageSyntheticFindings = normalized
    .filter(v => !v.coverageComplete)
    .map(v => makeCoverageFinding(v.reviewerId))

  const missing = manifest.reviewers.filter(id => !covered.some(v => v.reviewerId === id))
  const quorum = Math.max(1, Math.ceil(manifest.reviewers.length * 2 / 3))
  const deadlineReached = now >= manifest.startedAt + manifest.juryTimeoutSec * 1000

  if (covered.length < quorum) {
    if (!deadlineReached) return { verdict: "PENDING", missing }
    return { verdict: "INCONCLUSIVE", missing, reason: "quorum_lost_after_timeout" }
  }

  let agg = "GREEN"
  if (covered.some(v => v.verdict === "RED")) agg = "RED"
  else if (covered.some(v => v.verdict === "YELLOW")) agg = "YELLOW"

  return {
    verdict: agg,
    judgement: { label: agg, reason: summarizeJudgement(covered, missing) },
    recommendedAction: decideRecommendedAction(agg, covered, missing),
    reviewerCount: covered.length,
    missingCount: missing.length,
    evaluation: summarizeEvaluation(covered),
    findings: dedupeFindings([
      ...covered.flatMap(v => attachProvenance(v.findings, v.reviewerId)),
      ...coverageSyntheticFindings
    ]),
    perReviewer: Object.fromEntries(normalized.map(v => [
      v.reviewerId,
      { verdict: v.verdict, coverageComplete: v.coverageComplete }
    ]))
  }
}
```

### 19.1 coverage validate

required artifacts coverage は quorum 条件そのものとする。`read-set.jsonl` が required artifacts を全部含まない reviewer は `coverageComplete = false` として severity 集計から除外し、synthetic `coverage_incomplete` finding を注入する。`touched_files` は補助診断には使ってよいが、最終 coverage 判定の入力には使わない。

不完全 coverage の reviewer は `perReviewer` には残すが、`GREEN` / `YELLOW` / `RED` の最終判定には使わない。`coverage_incomplete` finding は `category = "review_meta"` とし、fix loop の入力に入れない。

### 19.2 dedupe

finding dedupe key は次とする。

- `filePath`
- `lineRange`
- `category`
- `descriptionDigest`

`descriptionDigest` は `lowercase + whitespace normalize + first 64 chars -> SHA1 first 8`。

### 19.3 aggregation mode

本設計の複数 reviewer は多数決 jury ではなく、`fail-closed-adversarial-gate` として集約する。

- quorum を満たした covered reviewer 群のうち、1 件でも `RED` があれば aggregate は `RED`
- `RED` が無く、1 件でも `YELLOW` があれば aggregate は `YELLOW`
- covered reviewer がすべて `GREEN` のときだけ aggregate は `GREEN`

したがって reviewer 数は「票数」ではなく、独立 adversarial pass 数として意味を持つ。

## 20. Fix cluster 分割

`clusters.mjs` は `routeTo != "review_meta"` の findings だけを unit 単位で分割する。

1. finding の `filePath` を見る
2. `team-composition.json` に `team-composition.patch.json` があれば overlay した effective team composition の `writePaths` / `writeFiles` と照合する
3. 一意に対応する unit があればその bucket に入れる
4. どの unit にも紐付かない場合は `fixer-orphan` cluster を作る

Fixer は 1 cluster だけを受け取り、その cluster manifest から導出された write scope のみを編集する。

### 20.1 `fixer-orphan` の扱い

`fixer-orphan` は即座に repo を編集しない。まず read-only triage を行い、`fixes/orphan/<cluster-id>/resolution.json` を作る。

`resolution.json` は次のいずれか 1 つの解決策を持つ。

- `reassign_existing_unit`
  - finding を既存 unit に再割当する
- `split_clusters`
  - finding を複数 unit に分割し直す
- `temporary_orphan_unit`
  - 一時 unit を作って修正する
- `replan_required`
  - plan 自体の unit 分解が不十分なので再 planning に戻す

`temporary_orphan_unit` は次の条件をすべて満たすときだけ許可する。

- `/mavsdd-approve-orphan` による human approval が記録され、`approvalRef` で参照できる
- `approvedWritePaths` / `approvedWriteFiles` が union of role `allowedWritePaths` の内側にある
- 既存 unit の write scope と非重複
- `team-composition.patch.json` に一時 unit が記録される
- `contexts/unit-<name>.md` が生成され、`briefPath` から参照できる
- effective team composition に overlay したとき、通常 unit と同じ roster validation を満たす

この解決 manifest が確定するまでは、`fixer-orphan` cluster は `workspace/repo/` に書けない。`replan_required` なら state は `plan_drafted` に戻す。

`team-composition.patch.json` は temporary orphan unit 専用の append-only patch artifact とし、少なくとも `schemaVersion`, `feature`, `createdAt`, `reason`, `temporaryUnits[]`, `approvalRef` を持つ。各 `temporaryUnits[]` は通常 unit と同じ shape を持ち、少なくとも `name`, `role`, `scope`, `verificationTier`, `writePaths`, `writeFiles`, `readPaths`, `readFiles`, `briefPath`, `originClusterId` を持つ。`/mavsdd-implement` と `/mavsdd-fix` は本体 `team-composition.json` にこの patch を overlay して有効 scope を計算する。

`/mavsdd-stage`、`/mavsdd-impl-review`、`/mavsdd-apply` も同じ overlay 後の effective team composition を参照しなければならない。

## 21. Hook 仕様

### 21.1 hooks.json

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/run-with-flags-strict.js\" mavsdd-path-phase-gate"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/run-with-flags-strict.js\" mavsdd-post-write-audit"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/mavsdd-load-active.js\""
          }
        ]
      }
    ],
    "TaskCreated": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/run-with-flags-strict.js\" mavsdd-task-created-gate"
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/run-with-flags-strict.js\" mavsdd-task-completed-gate"
          }
        ]
      }
    ],
    "TeammateIdle": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/run-with-flags-strict.js\" mavsdd-teammate-idle-gate"
          }
        ]
      }
    ]
  }
}
```

review preload の canonical audit は hook ではなく trusted CLI 自身が持つ。`codex-companion.mjs` の内部 `fs.readFile` はこの hook 面の対象外であり、設計上も使用しない。

SessionStart matcher については、現行 docs どおり `startup|resume|clear|compact` を採用する。ただし `spike-sessionstart-matcher.md` で runtime 実測し、不一致があれば `startup|resume` または matcher 省略へ narrowing してから実装を固定する。

### 21.2 PreToolUse write gate と phase ごとの運用対象

PreToolUse hook が canonical に enforce するのは `Write|Edit|MultiEdit|Bash` に対する write gate のみである。以下の file list は `Read` hook による強制ではなく、trusted CLI と lead session がその phase で参照してよい運用上の対象を示す。

phase ごとの command gate と運用上の参照対象は次のとおり。

- `∅` (`uninitialized`)
  - trusted CLI: `init`, `status`
- `init`
  - trusted CLI: `plan`, `status`, `resume`
- `plan_drafted`
  - trusted CLI: `plan`, `plan-review`, `status`, `resume`
  - `plan.md`
  - `specs/behavioral-spec.md`
  - `specs/requirements-index.json`
  - `specs/verification-architecture.md`
  - `specs/test-strategy.md`
  - `specs/convergence-checklist.md`
  - `traceability/coverage-matrix.json`
  - `traceability/contract-chain.jsonl`
  - `team-composition.json`
  - `contexts/planner-brief.md`
  - `contexts/repo-pointers.md`
  - `contexts/unit-*.md`
- `plan_reviewed` / `plan_review_inconclusive`
  - trusted CLI: `approve-plan`, `plan`, `status`, `resume`
- `plan_approved`
  - trusted CLI: `red`, `status`, `resume`
- `red_pending`
  - trusted CLI: `red`, `status`, `resume`
- `red_verified`
  - trusted CLI: `implement`, `status`, `resume`
- `plan_review_pending`
  - trusted CLI: `plan-review`, `aggregate`, `status`, `resume`
  - 現 iteration の `manifest.json`
  - 現 iteration の `artifact-digests.json`
  - 現 iteration の `reviewer-i/read-set.jsonl`
  - 現 iteration の `reviewer-i/raw-response.json`
  - 現 iteration の `reviewer-i/verdict.json`
  - 現 iteration の `aggregate.json`
  - 現 iteration の `.ready`
- `impl_review_pending`
  - trusted CLI: `impl-review`, `aggregate`, `status`, `resume`
  - 現 iteration の `manifest.json`
  - 現 iteration の `artifact-digests.json`
  - 現 iteration の `reviewer-i/read-set.jsonl`
  - 現 iteration の `reviewer-i/raw-response.json`
  - 現 iteration の `reviewer-i/verdict.json`
  - 現 iteration の `aggregate.json`
  - 現 iteration の `.ready`
- `implementing`
  - trusted CLI: `stage`, `status`, `resume`
  - `workspace/repo/` の unit scope
  - `workspace/runtime/<unit>/`
  - `implementations/<unit>/status.json`
- `fix_required`
  - trusted CLI: `fix`, `approve-orphan`, `status`, `resume`
  - `workspace/repo/` の unit scope
  - `workspace/runtime/<unit>/`
  - `implementations/<unit>/status.json`
  - `fixes/orphan/<cluster-id>/resolution.json`
  - `team-composition.patch.json`（human-approved temporary orphan unit の記録時のみ）
- `ready_to_stage`
  - trusted CLI: `stage`, `status`, `resume`
  - direct file tools は deny
- `impl_staged`
  - trusted CLI: `apply`, `status`, `resume`
- `impl_applying` / `verifying`
  - trusted CLI: `status`, `resume`
  - direct repo write は deny
- `impl_applied`
  - trusted CLI: `verify`, `status`, `resume`
- `verified`
  - trusted CLI: `impl-review`, `status`, `resume`
- `impl_reviewed` / `impl_review_inconclusive`
  - trusted CLI: `approve-impl`, `fix`, `status`, `resume`
- `done` / `blocked`
  - trusted CLI: `status`, `resume`
- その他
  - deny

Agent Teams の task lifecycle には `TaskCreated`, `TaskCompleted`, `TeammateIdle` を使える前提で設計する。ただしこれらは quality gate / feedback 用であり、正本は引き続き `team-runtime/task-ledger.jsonl` と `/mavsdd-resume` の reconciliation に置く。hook が失敗・未発火でも runtime recoverability は壊さない。

### 21.3 Bash の扱い

`Bash` は 2 系統に分ける。

1. direct shell write
2. trusted CLI invocation

`bash-write-detector.mjs` は次を検出する。

- `>`
- `>>`
- `tee`
- `tee -a`
- `sed -i`
- `awk -i inplace`
- `cp`
- `mv`
- `dd of=`
- `rsync` の write

検出した write targets は path gate で照合する。

一方、Skill から起動される `node scripts/cli/mavsdd.mjs init|plan|plan-review|aggregate|approve-plan|red|approve-orphan|implement|stage|apply|verify|impl-review|approve-impl|fix|status|resume` は trusted CLI invocation として phase 条件付きで許可する。

## 22. Skill 一覧

以下は user-facing Skill 名である。正規実装は `.claude/skills/mavsdd-*/SKILL.md` とし、各 Skill は対応する trusted CLI subcommand を呼び出す。legacy `.claude/commands/` は v1 では作らない。

### `/mavsdd-init <feature> [--jury N]`

- 初期 tree と rubric を作る
- state: `∅ -> init`

### `/mavsdd-plan "<request>"`

- Planner を走らせる
- `behavioral-spec`, `requirements-index`, `verification-architecture`, `test-strategy`, `planner-brief`, `repo-pointers`, `plan`, `team-composition`, `unit briefs`, `traceability seed`, `verification/profile` を作る
- state: `init -> plan_drafted`

### `/mavsdd-plan-review`

- review manifest を作る
- `snapshotId`, `manifestHash`, `artifact-digests.json`, reviewer `jobId/attemptKey/promptPayloadHash` を固定する
- reviewer の missing slot のみ再 spawn できる
- state: `plan_drafted | plan_review_pending -> plan_review_pending`

### `/mavsdd-aggregate --scope plan|impl [--force]`

- `aggregate.json` を作る
- 同じ `snapshotId` の valid reviewer verdict だけを集約する
- `verdict = PENDING` なら state を据え置き、missing reviewer slot の再 spawn を待つ
- state: `*_review_pending -> *_review_pending | *_reviewed | *_review_inconclusive`

### `/mavsdd-approve-plan [--verdict approve|reject] [--force-proceed]`

- human gate
- 現在の `manifestHash`, `aggregateHash`, `snapshotId`, `iteration` と束縛された approval record を残す
- `plan_reviewed` なら approve で `plan_approved`、reject で `plan_drafted`
- `plan_review_inconclusive` なら `--force-proceed` 付き approve で `plan_approved`、それ以外は `plan_drafted`

### `/mavsdd-red`

- `test-strategy` を failing tests に具体化する
- `red/test-matrix.json`, `red/failing-tests.json`, `red-phase.log` を作る
- 新機能テストが fail、既存回帰が pass であることを hard gate とする
- state: `plan_approved -> red_pending -> red_verified`

### `/mavsdd-implement`

- workspace materialize
- Agent Team create + topo fan-out（tool 名と引数は `spike-team-create.md` 後に実名へ置換）
- unit ごとに green -> refactor を要求
- state: `red_verified -> implementing`

### `/mavsdd-stage`

- `workspace/repo` vs `workspace/base` を diff
- operations manifest を作る
- state: `implementing -> ready_to_stage -> impl_staged`

### `/mavsdd-apply`

- apply-lock を確保
- `applyTxnId` を計算し、同一 txn の committed record があれば idempotent success
- baseHash 検証付きで live repo に適用
- rollback あり
- state: `impl_staged -> impl_applying -> impl_applied`

### `/mavsdd-verify [--tier auto|tier0|tier1|tier2|tier3]`

- verification tier runner を実行
- `verification/summary.json` と `verification/reports/<unit>.md` を作る
- `overallVerdict = PASS` なら state: `impl_applied -> verifying -> verified`
- `overallVerdict = FAIL` なら state: `impl_applied -> verifying -> fix_required`

### `/mavsdd-impl-review`

- impl review manifest を作り Codex jury を走らせる
- `snapshotId`, `manifestHash`, `artifact-digests.json`, reviewer `jobId/attemptKey/promptPayloadHash` を固定する
- reviewer の missing slot のみ再 spawn できる
- state: `verified | impl_review_pending -> impl_review_pending`

### `/mavsdd-approve-impl [--verdict approve|reject] [--force-proceed]`

- `temporary_orphan_unit` を採る場合は事前に `/mavsdd-approve-orphan` が必要
- 現在の `manifestHash`, `aggregateHash`, `snapshotId`, `iteration` と束縛された approval record を残す
- GREEN + approve で done
- non-GREEN で fix_required
- `impl_reviewed` なら GREEN + approve で `done`、それ以外は `fix_required`
- `impl_review_inconclusive` なら `--force-proceed` 付き approve で `done`、それ以外は `fix_required`

### `/mavsdd-approve-orphan <cluster-id> [--verdict approve|reject]`

- `temporary_orphan_unit` 用の human gate
- `human-approvals.jsonl` に `approvalId`, `approvalKind`, `clusterId`, `snapshotId`, `manifestHash`, `aggregateHash`, `verdict`, `reason`, `approvedBy`, `createdAt` を append する
- approve された場合のみ `team-composition.patch.json.approvalRef` に参照を張れる
- state: `fix_required -> fix_required`

### `/mavsdd-fix`

- finding clusters を作る
- cluster job は `sourceSnapshotId + clusterId` で idempotent に扱う
- Fixer Team を走らせる
- orphan triage が `replan_required` を返したら `plan_drafted` に戻す
- それ以外は `fix_required -> implementing (iter N+1)`

### `/mavsdd-status`

- 読み取り専用

### `/mavsdd-resume [<feature>]`

- session restart 後の再開
- unfinished unit と missing reviewer slot だけ再 spawn する
- native teammate 復元には依存しない

## 23. ステートマシン

```text
init
  -> plan_drafted
plan_drafted
  -> plan_review_pending
  -> plan_drafted (re-plan)
plan_review_pending
  -> plan_review_pending (aggregate=PENDING | plan-review rerun)
  -> plan_reviewed
  -> plan_review_inconclusive
plan_reviewed
  -> plan_approved
  -> plan_drafted
plan_review_inconclusive
  -> plan_approved (--force-proceed)
  -> plan_drafted
plan_approved
  -> red_pending
red_pending
  -> red_pending (red rerun)
  -> red_verified
  -> plan_drafted
red_verified
  -> implementing
implementing
  -> ready_to_stage
ready_to_stage
  -> impl_staged
impl_staged
  -> impl_applying
impl_applying
  -> impl_applied
impl_applied
  -> verifying
verifying
  -> verified
  -> fix_required
verified
  -> impl_review_pending
impl_review_pending
  -> impl_review_pending (aggregate=PENDING | impl-review rerun)
  -> impl_reviewed
  -> impl_review_inconclusive
impl_reviewed
  -> done
  -> fix_required
impl_review_inconclusive
  -> done (--force-proceed)
  -> fix_required
fix_required
  -> implementing (iter N+1)
  -> plan_drafted (orphan triage => replan_required)
  -> blocked (iter > 3 and still non-GREEN)
```

## 24. Runtime spike（blocking）

v1 着手前に必ず次を検証する。Phase 0 は優先度順に実施する。

Priority 0: plan 全体の成立条件

1. `spike-team-create.md`
   - Agent Teams を experimental 有効化したうえで team create / task assignment / teammate messaging が使えるか
   - exact tool 名、引数 shape、team/task lifecycle を採取する
2. `spike-codex-parallel.md`
   - 3 x Codex reviewer を並列発火できるか
   - external Codex adapter の exact invocation contract を採取する

この 2 本のどちらかが落ちたら、plan 全体を再検討してから先へ進む。

Priority 1: 契約固定と互換確認

3. `spike-sessionstart-matcher.md`
   - `SessionStart` の `startup|resume|clear|compact` matcher が runtime でも実在するか
   - 不一致なら `startup|resume` または matcher 省略へ narrowing する
4. `spike-hook-boundary.md`
   - Team agent の `Write|Edit|MultiEdit|Bash` が期待どおり hook 面に乗るか
   - trusted CLI の review path と hook-based write gate が競合しないか
   - `TaskCreated` / `TaskCompleted` / `TeammateIdle` が期待どおり発火し、feedback gate に使えるか
5. `spike-red-gate.md`
   - `red/test-matrix.json`, `red/failing-tests.json`, `red-phase.log` によって failing-tests-first を hard gate にできるか
6. `spike-bash-gate.md`
   - redirect / tee / sed -i が deny されるか
7. `spike-child-process-visibility.md`
   - `Bash("node ...")` の子プロセス内部 write を hook が見ない前提を確認する
8. `spike-planner-xhigh.md`
   - planner effort 指定が効くか
9. `spike-workspace-materialize.md`
   - `base` / `repo` / `runtime` materialize の意味論と速度
10. `spike-realpath-symlink.md`
   - symlink / traversal が reject されるか
11. `spike-stage-conflict.md`
   - materialize 後の live repo drift が apply conflict になるか
12. `spike-agent-team-resume-gap.md`
   - native `/resume` に依存せず `.mavsdd/team-runtime` から再 spawn できるか
13. `spike-verification-tier.md`
   - tier0-2 の verification runner と artifact 保存が end-to-end で動くか
14. `spike-fixer-orphan-resolution.md`
   - orphan finding が read-only triage -> resolution manifest -> approved scope で再開できるか
15. `spike-model-resolution-persistence.md`
   - `requestedModel`, `resolvedModel`, `provider`, `resolvedEffort`, `runtimeVersion` を各 run artifact に保存できるか
   - policy mismatch 時に fail-closed で止まるか
16. `spike-review-read-audit.md`
   - `/mavsdd-plan-review` / `/mavsdd-impl-review` の trusted CLI preload が manifest 外 read を reject し、reviewer slot ごとの `read-set.jsonl` と `artifact-digests.json` を残せるか
   - `codex-companion.mjs` が repo file I/O を行わなくても aggregate が `coverageComplete=true` を判定できるか
17. `spike-review-snapshot-freeze.md`
   - 同一 iteration の全 reviewer が同じ `snapshotId`, `artifact-digests.json`, `promptPayloadHash` を参照できるか
18. `spike-approval-binding.md`
   - `approve-plan`, `approve-impl`, `approve-orphan` が `manifestHash`, `aggregateHash`, `snapshotId` に束縛されるか
19. `spike-apply-idempotency.md`
   - `applyTxnId` により二重 apply を防げるか
20. `spike-fix-idempotency.md`
   - `sourceSnapshotId + clusterId` により fix rerun が二重生成されないか
21. `spike-budget-gc.md`
   - token budget, retention, workspace GC の制限が fail-closed で効くか

Priority 1 の spike が落ちた場合は、該当 section を修正してから先へ進む。特に `spike-team-create.md` 完了後は §10 / §11 / §22 の team primitive 仮称を実 API 名へ置換し、`spike-codex-parallel.md` 完了後は §8.7 の adapter 契約を実インターフェースへ置換する。

## 25. 実装フェーズ

### Phase 0. Spike

- 上記 21 spike
- 先に `spike-team-create.md` と `spike-codex-parallel.md` を完了し、成立条件を満たした場合のみ残りへ進む

### Phase A. Schema + library

- `schemas/*.json`
- `paths.mjs`
- `state.mjs`
- `roster.mjs`
- `verdict-validator.mjs`
- `aggregate.mjs`
- `clusters.mjs`
- `bash-write-detector.mjs`
- `workspace.mjs`
- `verification-runner.mjs`
- `diff-to-operations.mjs`
- `apply-engine.mjs`
- `apply-lock.mjs`
- `tests/lib/*.test.mjs`

### Phase B. Planner + red gate + plan-review vertical slice

- planner agent + aggregate library
- `mavsdd-init`, `mavsdd-plan`, `mavsdd-red`, `mavsdd-plan-review`, `mavsdd-aggregate`, `mavsdd-approve-plan`
- VSDD spec artifact 生成
- hook 群
- plan review の再エントリ

### Phase C. Implement + stage + apply

- implementer agent
- `mavsdd-implement`, `mavsdd-stage`, `mavsdd-apply`, `mavsdd-resume`
- baseline-manifest
- team-runtime ledger
- conflict / rollback

### Phase D. Verify + impl review + fix loop

- fixer agent
- `mavsdd-verify`, `mavsdd-impl-review`, `mavsdd-approve-impl`, `mavsdd-fix`
- cluster partition
- verification tiers
- iter cap 3

### Phase E. Docs + install

- `mavsdd-status`
- `.claude-plugin/plugin.json`
- `install.sh`
- `README.md`
- Agent Teams の experimental 有効化手順と `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` の前提を明記

## 26. 検証基準

### 26.1 library test

- `node --test tests/lib`
- 重点対象:
  - safeCanonical の新規 file 対応
  - symlink reject
  - write scope overlap
  - fixer cluster-derived scope
  - coverage downgrade
  - baseHash conflict
  - rollback
  - dedupe
  - verdict schema validate
  - verification tier resolution
  - orphan resolution gate

### 26.2 plan review E2E

- `init -> plan -> plan-review -> aggregate -> approve-plan`
- `aggregate = PENDING` の間は `plan_review_pending` に留まり、`plan-review` rerun で missing slot のみ再 spawn
- reviewer 2/3 完了で session kill
- `resume` 後に reviewer 3 だけ再 spawn

### 26.3 red gate E2E

- `approve-plan -> red`
- `red/test-matrix.json` に全 `REQ-*` と `TEST-*` が出力される
- 新機能テスト fail / 既存回帰 pass が `red-phase.log` に残る
- red gate 未達なら `implementing` に進まない

### 26.4 impl E2E

- 3 unit topology
- workspace 内で green -> refactor 実行
- stage で add / overwrite / delete / rename / chmod を表現
- apply 中に live repo を変えると conflict + rollback

### 26.5 verification E2E

- `apply -> verify -> impl-review`
- tier1 で property / mutation の artifact が残る
- tier2 で fuzz / stress の artifact が残る
- verification fail で `impl_review_pending` に進まない

### 26.6 review snapshot / approval E2E

- review iteration 開始後に artifact を変更すると新 iteration が作られ、旧 iteration は継続しない
- `approve-plan` / `approve-impl` / `approve-orphan` が `snapshotId`, `manifestHash`, `aggregateHash` 不一致で reject される

### 26.7 fix loop E2E

- intentional bug -> RED
- fix -> stage -> apply -> verify -> review(iter 2)
- iter 3 を超えたら `blocked`

### 26.8 orphan fix E2E

- cross-unit finding -> `fixer-orphan`
- read-only triage で `resolution.json` を生成
- `temporary_orphan_unit` の場合は `/mavsdd-approve-orphan` で `approvalId` を発行
- human-approved temporary orphan unit または existing unit reassignment 後にのみ修正開始
- 未承認なら repo write は拒否される

### 26.9 idempotency / GC E2E

- 同じ `applyTxnId` の再実行は no-op success になる
- 同じ `sourceSnapshotId + clusterId` の fix rerun は duplicate cluster を作らない
- budget 超過時は fail-closed で止まり、artifact retention / workspace GC が実行される

## 27. リスクと緩和

- Team / Codex primitive が未サポート
  - Phase 0 spike で確認
- Agent Teams の native resume が弱い
  - `.mavsdd/team-runtime` 正本 + 再 spawn で扱う
- hook と agent 種別で surface がズレる
  - spike で確認
- red gate が形骸化する
  - `red-phase.log` と `failing-tests.json` を hard gate にし、未達なら `implementing` に進めない
- model alias が provider 更新で drift する
  - `run-metadata` に requested / resolved を保存し、policy mismatch は fail-closed で止める
- child process write は hook の外にある
  - trusted CLI と library test で扱う
- large repo で workspace materialize が重い
  - v1 は rsync / copy、v1.1 で reflink / worktree を検討
- planner が過剰 scope を出す
  - schema + roster hard reject
- reviewer が artifact を読み切らない
  - trusted CLI preload の `read-set.jsonl` と `artifact-digests.json` の突合で quorum から除外し、synthetic finding を付与
- VSDD verification がプロジェクト言語ごとにばらつく
  - `verification/profile.json` と pluggable runner で扱う
- orphan finding が unit ownership に収まらない
  - read-only triage + human-approved temporary unit で扱う
- fix loop が振動する
  - iter cap 3
- approval が別 snapshot に誤結合する
  - `manifestHash`, `aggregateHash`, `snapshotId` を approval record に必須化する
- rerun で duplicate apply / duplicate fix が起こる
  - `applyTxnId`, `jobId`, `attemptKey`, `sourceSnapshotId + clusterId` を導入する
- token cost と artifact 保存量が膨らむ
  - token budget, reviewer retry 上限, retention, workspace GC を config で fail-closed に管理する

## 28. スコープ外

- malicious agent 耐性
- container / seccomp / ptrace sandbox
- すべての言語での fully automated formal proof backend
- independent MCP server
- multi-feature concurrent execution
- auto-commit
- git worktree ベース workspace の本格導入

## 29. 最終判断

この rev-11 で、以前の blocking point は次のように閉じた。

- `baseHash` は materialize 時 baseline 固定
- `apply-lock` は token ではなく排他専用
- `stage/apply/verify` は trusted CLI として hook から切り離し
- `safeCanonical` は新規 file に対応
- rubric / repo-pointers / planner-brief / unit briefs の生成責務を明記
- repository slug / CLI slug / runtime slug を `mavsdd` に統一した
- workspace test の一時出力先を `workspace/runtime/<unit>/` に分離
- VSDD の本体として `behavioral-spec`, `verification-architecture`, `test-strategy`, `convergence-checklist` を成果物に戻した
- `requirements-index`, `traceability/contract-chain.jsonl`, `coverage-matrix` を追加し、`REQ -> TEST -> UNIT -> operations -> FINDING -> resolution` の接続を定義した
- `red` フェーズを独立させ、`red-phase.log`, `test-matrix`, `failing-tests` を hard gate にした
- Agent Teams の native resume に依存せず、`.mavsdd/team-runtime` を正本にした
- `reviewer-jobs.json` を review resume の正本として生成責務 / 更新責務に入れた
- reviewer report に `evaluation` と `judgement` を必須化した
- Codex reviewer は `gpt-5.4/high`、Planner は `opus/xhigh`、Sonnet 実行系は `high` を既定にし、requested / resolved model を永続化するようにした
- `state.json`, `config.json`, `active.json` の最小 schema と feature-level の正規 field 名 `phase` を定義し、`redIteration`, budget, retention, review policy を追加した
- review snapshot を `snapshotId`, `artifact-digests`, `promptPayloadHash` で固定し、Codex reviewer の file I/O を禁止した
- approval record を `manifestHash`, `aggregateHash`, `snapshotId` に束縛した
- `applyTxnId` と cluster job key を導入し、rerun 時の idempotency を明文化した
- verification tier の pass/fail 契約、`verification/profile.json`、orphan finding の解決フローを明文化した
- `/mavsdd-red` を model invocation metadata の対象に加えた
- traceability の append 責務を `implement/stage/verify/review/fix` まで拡張した
- 21.2 を read hook enforcement ではなく write gate + 運用上の参照対象として明示した
- runtime spike を Codex reviewer non-write 前提に合わせて `spike-hook-boundary.md` へ更新した
- user-facing entrypoint を legacy custom commands ではなく project / plugin Skills に統一した
- review flow の全体像を `plan-review/impl-review` と `aggregate` の分離後の実仕様に揃えた
- Codex reviewer invocation path を external adapter 表現で統一し、`codex-companion.mjs` を仮固定から候補扱いへ下げた

この設計であれば、ユーザー要求である「Planner + Codex jury + Agent Team implementers/fixers + disk-first persistence + human gate」を、VSDD artifact と verification loop を含む形で実装可能にできる。
