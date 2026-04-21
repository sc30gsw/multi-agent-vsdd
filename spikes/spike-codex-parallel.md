# spike-codex-parallel

## Goal

Codex reviewer を trusted CLI から直接起動し、artifact digests / read-set / raw response / verdict を保存する。

## Observed Local State

- `codex --version`: `codex-cli 0.122.0`
- `codex login status`: `Logged in using ChatGPT`

## Chosen Invocation Surface

v1 では `codex exec` を reviewer transport に固定する。

```bash
codex exec \
  --skip-git-repo-check \
  --ephemeral \
  --sandbox read-only \
  --model gpt-5.4 \
  --output-schema <schema-path> \
  --output-last-message <verdict-path> \
  -
```

trusted CLI は reviewer prompt を stdin で渡し、以下を canonical artifact として保存する。

- `manifest.json`
- `artifact-digests.json`
- `reviewer-i/prompt.md`
- `reviewer-i/read-set.jsonl`
- `reviewer-i/raw-response.json`
- `reviewer-i/verdict.json`

## Sandbox Note

この Codex sandbox では home 配下 session dir 書き込みが制限される。repo 実運用では host 側 CLI 実行を前提とし、必要なら昇格実行で回避する。
