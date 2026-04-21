# spike-verdict-promotion

## Goal

`.inbox/verdict.json` → schema 検証 → atomic rename → canonical `verdict.json` → quorum 到達時に `.ready` touch、という promote pipeline を end-to-end で確認する。

## Result

**PASS**

- `scripts/hooks/mavsdd-promote-and-sentinel.js` が PostToolUse で呼ばれる。
- JSON schema 検証は `scripts/lib/schema.mjs`（`mavsdd-verdict` + `mavsdd-finding`）を経由。失敗時は `.inbox/validation-errors.json` を書いて stage のまま残す。
- 成功時は `fs.renameSync` で canonical path に移動（atomic）。
- manifest.reviewers 全員分の canonical verdict が揃った時点で `.ready` を touch。
- Tests:
  - `tests/lib/hooks.test.mjs :: promote-and-sentinel renames a valid staged verdict and touches .ready when quorum is met`
  - `tests/lib/hooks.test.mjs :: promote-and-sentinel writes validation-errors.json for bad verdicts`

## Residual Risk

- 複数 reviewer が同時書き込みした場合の rename の原子性は OS 依存（POSIX 保証あり、macOS APFS で実動作確認済み）。
