import test from "node:test";
import assert from "node:assert/strict";

import {
  detectBashWrites,
  extractWritePaths,
  tokenize,
  splitSimpleCommands
} from "../../scripts/lib/bash-write-detector.mjs";

test("tokenize handles quoted strings and escapes", () => {
  assert.deepEqual(tokenize(`echo "hello world" 'single' > out.txt`), [
    "echo",
    "hello world",
    "single",
    ">",
    "out.txt"
  ]);
});

test("splitSimpleCommands splits pipelines and sequences", () => {
  const tokens = tokenize("ls | grep foo && rm bar; mkdir baz");
  const commands = splitSimpleCommands(tokens);
  assert.equal(commands.length, 4);
  assert.deepEqual(commands[0], ["ls"]);
  assert.deepEqual(commands[1], ["grep", "foo"]);
  assert.deepEqual(commands[2], ["rm", "bar"]);
  assert.deepEqual(commands[3], ["mkdir", "baz"]);
});

test("detectBashWrites extracts redirect targets (> and >>)", () => {
  assert.deepEqual(extractWritePaths("echo hi > out.txt"), ["out.txt"]);
  assert.deepEqual(extractWritePaths("echo hi >> out.txt"), ["out.txt"]);
  assert.deepEqual(extractWritePaths("echo hi 2> err.log"), ["err.log"]);
});

test("detectBashWrites picks up tee targets including -a", () => {
  assert.deepEqual(extractWritePaths("echo hi | tee out.txt"), ["out.txt"]);
  assert.deepEqual(extractWritePaths("echo hi | tee -a out.txt"), ["out.txt"]);
  assert.deepEqual(extractWritePaths("echo hi | tee a.txt b.txt"), ["a.txt", "b.txt"]);
});

test("detectBashWrites detects sed -i in-place edits", () => {
  assert.deepEqual(extractWritePaths("sed -i 's/a/b/' path/to/file.js"), ["path/to/file.js"]);
  assert.deepEqual(extractWritePaths("sed -i.bak 's/a/b/' path/to/file.js"), ["path/to/file.js"]);
  assert.deepEqual(extractWritePaths("sed -n 's/a/b/p' path/to/file.js"), []);
});

test("detectBashWrites detects cp / mv / install destinations", () => {
  assert.deepEqual(extractWritePaths("cp a.txt b.txt"), ["b.txt"]);
  assert.deepEqual(extractWritePaths("mv src/one.txt dist/two.txt"), ["dist/two.txt"]);
  assert.deepEqual(extractWritePaths("install -m 644 config.toml /etc/app/config.toml"), [
    "/etc/app/config.toml"
  ]);
});

test("detectBashWrites detects rm / mkdir / touch targets", () => {
  assert.deepEqual(extractWritePaths("rm -rf build/ dist/"), ["build/", "dist/"]);
  assert.deepEqual(extractWritePaths("mkdir -p logs data"), ["logs", "data"]);
  assert.deepEqual(extractWritePaths("touch file.flag"), ["file.flag"]);
});

test("detectBashWrites detects dd of= and ln -s targets", () => {
  assert.deepEqual(extractWritePaths("dd if=/dev/zero of=/tmp/zero bs=1M count=1"), ["/tmp/zero"]);
  assert.deepEqual(extractWritePaths("ln -s src/real dist/link"), ["dist/link"]);
});

test("detectBashWrites reports multiple writes in one compound command", () => {
  const writes = detectBashWrites("echo a > one.txt && echo b >> two.txt ; tee three.txt");
  const paths = writes.map((entry) => entry.path).sort();
  assert.deepEqual(paths, ["one.txt", "three.txt", "two.txt"]);
});

test("detectBashWrites returns empty array for pure read commands", () => {
  assert.deepEqual(detectBashWrites("ls -la"), []);
  assert.deepEqual(detectBashWrites("grep -R foo src/"), []);
  assert.deepEqual(detectBashWrites("cat file.txt"), []);
});
