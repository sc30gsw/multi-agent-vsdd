# spike-apply-token

## Goal

`/mavsdd-apply` subprocess に env 経由で `MAVSDD_APPLY_TOKEN` + `MAVSDD_APPLY_PARENT_PID` を渡し、hook 側で token + PID + `.apply-lock` 内容の整合を確認できるか検証する。env が hook プロセスに継承されない場合の fallback 方針を決定する。

## Result

**PASS（in-process モード）／ Fallback 決定済み（subprocess モード）**

- `scripts/lib/apply-lock.mjs` が `acquireLock` 時に `{feature, pid, nonce, startedAt}` を `.mavsdd/.apply-lock` に JSON で永続化。`verifyLock` で token / parent pid を照合。
- `scripts/lib/mavsdd-core.mjs :: applyOperations` は lock 取得 → apply → finally 解放、in-process で完結するモード。
- `scripts/lib/mavsdd-core.mjs :: applyOperationsInSubprocess` + `scripts/cli/apply-worker.mjs` が subprocess 経路を提供。env に `MAVSDD_APPLY_TOKEN` / `MAVSDD_APPLY_PARENT_PID` / `MAVSDD_APPLY_FEATURE` / `MAVSDD_REPO_ROOT` を注入。
- `scripts/hooks/mavsdd-path-phase-gate.js :: assertApplyAuthorization` は `.apply-lock` 存在 + `process.env.MAVSDD_APPLY_TOKEN === lock.nonce` + `process.env.MAVSDD_APPLY_PARENT_PID === String(lock.pid)` を要求する（`tests/lib/hooks.test.mjs :: honors a valid apply-lock with env token + PID`）。
- env が hook プロセスに継承されない実装の場合: lock 存在 + PID 照合のみで judgment し、token 不整合時は deny（fail-closed）。user には README の CLI 経由での `!node scripts/cli/mavsdd.mjs apply` 起動を推奨する。

## Residual Risk

- Claude Code の PreToolUse hook に env がそのまま渡るかは実機で X15 時に最終確認する。渡らない場合でも lock の PID を hook 側から取り、`process.ppid` などと比較する縮退モードを用意済み。
