# spike-realpath-symlink

## Goal

`workspace/<unit>/foo -> /etc/passwd` のような symlink 攻撃、`..` traversal、絶対パス escape を gate と apply 側双方で確実に拒否できることを確認する。

## Result

**PASS**

- `scripts/lib/paths.mjs :: safeCanonical`:
  - `..` を含むセグメントを `PathRejection("path traversal not allowed")` で拒否
  - 絶対パス（`/etc/...`）が REPO_ABS 外なら `PathRejection("path escapes root ...")` で拒否
  - `fs.realpathSync.native` で canonical 解決し、再度 REPO_ABS 配下か確認
  - REPO_ABS から target までの全 component を `fs.lstatSync` で symlink チェック、見つかった時点で拒否
- `scripts/hooks/mavsdd-path-phase-gate.js` は `safeCanonical` を使い、`PathRejection` を block 理由として返す。
- tests:
  - `tests/lib/paths.test.mjs :: safeCanonical rejects a path that traverses through a symlink`
  - `tests/lib/paths.test.mjs :: safeCanonical rejects a path whose ancestor directory is a symlink`
  - `tests/lib/paths.test.mjs :: safeCanonical rejects parent-directory traversal`
  - `tests/lib/paths.test.mjs :: safeCanonical rejects absolute paths outside the root`
  - `tests/lib/hooks.test.mjs :: path-phase-gate rejects paths that traverse through a symlink`

## Residual Risk

- TOCTOU: 検査後〜apply 書き込み直前に symlink が差し替わる可能性は残る。`apply-engine.mjs` は書き込み直前に baseHash 照合するため、swap された場合は hash mismatch で rollback される（chained defense）。
