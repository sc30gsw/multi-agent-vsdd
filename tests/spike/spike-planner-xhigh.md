# spike-planner-xhigh

## Goal

Planner agent の `effort: xhigh` がランタイムに伝わるか、伝わらない場合の fallback を用意する。

## Result

**PARTIAL — 設計上は解決済み、実ランタイム検証は X15 で継続確認**

- `agents/mavsdd-planner.md` の YAML frontmatter に `model: opus` と `effort: xhigh` を宣言。
- ランタイムが `effort` frontmatter を honor しない場合に備え、`templates/planner-system.md` で「xhigh レベルで思考せよ」と prompt 側にも明示的に指示を埋め込んでいる。
- README の threat model で「decomposition は blocking design review として扱う」旨を強調。

## Residual Risk

- Claude Code の agent frontmatter で effort を読む部分は版による差があり、最新 CLI が honor しているかは X15 で live 実行して判定する。
- 万一 effort がロードされない場合でも prompt fallback が動作するので planning が「opus default effort」レベルには保たれる。
