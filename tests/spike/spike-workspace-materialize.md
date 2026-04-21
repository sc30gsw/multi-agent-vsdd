# spike-workspace-materialize

## Goal

`materializeWorkspaces()` が `.mavsdd/features/<name>/workspace/repo` と `workspace/base` を作成し、`.git` / `node_modules` / `.mavsdd` を除外し、baseline-manifest に sha256 を記録することを確認する。

## Result

**PASS**

- `scripts/lib/mavsdd-core.mjs :: materializeWorkspaces` が以下を実施:
  - `workspace/base` と `workspace/repo` に再帰コピー（`copyTree`）
  - excluded: `.git`, `node_modules`, `.mavsdd`
  - `workspace/baseline-manifest.json` に全ファイルの `{sha256, bytes}` を書き込む
- `scripts/lib/diff-to-operations.mjs :: buildManifest` は symlink を skip するため、workspace 内に symlink を作っても baseline に漏れない（`tests/lib/diff-to-operations.test.mjs :: buildManifest skips symbolic links`）。
- integration: `tests/mavsdd.test.mjs :: stage, apply, verify, and aggregate remain deterministic` で materialize → stage → apply → verify のフローが通る。

## Residual Risk

- 巨大リポ（数 GB）では rsync 系の代わりに copy-on-write (APFS clonefile / btrfs reflink) / git worktree への切替が必要。v1 は stdlib copy に留め、v1.1 で検討。
