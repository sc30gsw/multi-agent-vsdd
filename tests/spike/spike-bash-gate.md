# spike-bash-gate

## Goal

Bash redirect / tee / sed -i / cp / mv / rm / mkdir / install / dd / ln -s を gate が横断して抽出・deny できることを確認する。

## Result

**PASS**

- `scripts/lib/bash-write-detector.mjs` が以下を抽出:
  - `echo foo > bar` → `bar`
  - `echo foo >> bar` → `bar`
  - `echo err 2> err.log` → `err.log`
  - `tee a b`, `tee -a path` → 列挙された path
  - `sed -i 's/a/b/' file` → `file`
  - `cp src dst`, `mv src dst`, `install src dst` → `dst`
  - `rm -rf a b`, `mkdir a b`, `touch flag` → 各 path
  - `dd if=/dev/zero of=/tmp/zero` → `/tmp/zero`
  - `ln -s target link` → `link`
  - `chmod 755 path`, `chown user path` → `path`
- `;`, `&&`, `||`, `|` を越えた複合コマンドも `splitSimpleCommands` で分割して全 path を抽出する。
- PureRead（`ls`, `grep`, `cat`）は空配列を返す。
- Tests: `tests/lib/bash-write-detector.test.mjs`（10 ケース）で検証済み。

## Residual Risk

- heredoc redirection (`cat <<EOF > path`) は redirect 抽出で拾えるが、内部の `$()`-evaluated path までは展開しない。v1 は fail-closed なので「怪しい形は deny する」側に倒す。
