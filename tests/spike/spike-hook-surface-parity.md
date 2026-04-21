# spike-hook-surface-parity

## Goal

`Write`, `Edit`, `MultiEdit`, `Bash` を跨いで同じ PreToolUse/PostToolUse matcher を走らせ、Claude agent と Codex reviewer の書き込みが同じ hook 面で捕捉できることを確認する。

## Result

**PASS（実装ベースで確認済み）**

- `hooks/hooks.json` の matcher は `Write|Edit|MultiEdit|Bash` を両方のフェーズで宣言している（plan §15 通り）。
- `scripts/hooks/run-with-flags-strict.js` が全 handler を fail-closed で dispatch する。
- `scripts/hooks/mavsdd-path-phase-gate.js` は:
  - `Write` / `Edit`: `tool_input.file_path` を直接取得
  - `MultiEdit`: `tool_input.file_path` + 各 `edits[].file_path`
  - `Bash`: `scripts/lib/bash-write-detector.mjs` で `>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `chmod`, `dd of=`, `ln -s` を抽出
- `tests/lib/hooks.test.mjs` の `path-phase-gate blocks Bash commands that write outside .mavsdd` で実走確認。

## Residual Risk

- Codex reviewer が Write 以外を使う挙動は `templates/codex-rubric-*.md` で Prompt 側から強制しているが、runtime が実際に Edit/Bash を選んだ場合は promote-and-sentinel 側の Bash path 抽出にも依存する。
- Claude Code 実機での PostToolUse matcher 実行は integration レベルで継続監視（X15 E2E でログ確認）。
