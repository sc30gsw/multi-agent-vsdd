const STOP_TOKENS = new Set([";", "&&", "||", "|", "&"]);

const WRITE_COMMANDS = new Map([
  ["tee", { startAt: 1, skipFlags: ["--append", "-a", "-i"], acceptFlag: (flag) => ["-a", "--append"].includes(flag) }],
  ["sed", { type: "sed" }],
  ["cp", { type: "cp-mv-install" }],
  ["mv", { type: "cp-mv-install" }],
  ["install", { type: "cp-mv-install" }],
  ["rm", { type: "every-non-flag" }],
  ["rmdir", { type: "every-non-flag" }],
  ["mkdir", { type: "every-non-flag" }],
  ["touch", { type: "every-non-flag" }],
  ["chmod", { type: "chmod" }],
  ["chown", { type: "chown" }],
  ["ln", { type: "ln" }],
  ["dd", { type: "dd" }]
]);

function stripQuotes(word) {
  if (word.length >= 2) {
    const first = word[0];
    const last = word[word.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return word.slice(1, -1);
    }
  }
  return word;
}

export function tokenize(command) {
  const tokens = [];
  let buffer = "";
  let quote = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        buffer += ch;
      } else if (ch === "\\" && quote === "\"") {
        buffer += ch + (command[i + 1] ?? "");
        i += 1;
      } else {
        buffer += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "\\" && command[i + 1]) {
      buffer += command[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buffer) {
        tokens.push(buffer);
        buffer = "";
      }
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      if (buffer) {
        tokens.push(buffer);
        buffer = "";
      }
      if ((ch === "|" && command[i + 1] === "|") || (ch === "&" && command[i + 1] === "&")) {
        tokens.push(ch + ch);
        i += 2;
      } else {
        tokens.push(ch);
        i += 1;
      }
      continue;
    }
    buffer += ch;
    i += 1;
  }
  if (buffer) tokens.push(buffer);
  return tokens.map(stripQuotes);
}

export function splitSimpleCommands(tokens) {
  const commands = [];
  let current = [];
  for (const token of tokens) {
    if (STOP_TOKENS.has(token)) {
      if (current.length > 0) commands.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

function findRedirectTargets(tokens) {
  const results = [];
  const redirectRe = /^([0-9]*)(&?>>|&?>|2>|2>>|>>|>|&>|<<<)$/;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const match = redirectRe.exec(token);
    if (!match) continue;
    const next = tokens[index + 1];
    if (next) {
      if (token.endsWith("<<<")) continue;
      results.push({ kind: "redirect", path: next });
      tokens[index] = "";
      tokens[index + 1] = "";
    } else {
      const split = /^([0-9]*&?>{1,2}|&>)(.+)$/.exec(token);
      if (split) {
        results.push({ kind: "redirect", path: split[2] });
        tokens[index] = "";
      }
    }
  }
  return results;
}

function nonFlagArgs(argv, options = {}) {
  const { includeDoubleDash = false } = options;
  const filtered = [];
  let sawDoubleDash = false;
  for (const token of argv) {
    if (!token) continue;
    if (!sawDoubleDash && token === "--") {
      sawDoubleDash = true;
      if (includeDoubleDash) continue;
      continue;
    }
    if (sawDoubleDash) {
      filtered.push(token);
      continue;
    }
    if (token.startsWith("-")) continue;
    filtered.push(token);
  }
  return filtered;
}

function detectForSimpleCommand(argv) {
  const writes = [];
  const redirects = findRedirectTargets(argv);
  for (const entry of redirects) writes.push(entry);
  const compact = argv.filter((token) => token);
  if (compact.length === 0) return writes;
  const command = compact[0];
  const config = WRITE_COMMANDS.get(command);
  if (!config) return writes;

  if (config.type === "sed") {
    const hasInPlace = compact.slice(1).some((arg) => arg === "-i" || /^-i/.test(arg) || arg === "--in-place");
    if (!hasInPlace) return writes;
    const positional = nonFlagArgs(compact.slice(1));
    for (const candidate of positional.slice(1)) {
      writes.push({ kind: "sed-in-place", path: candidate });
    }
    return writes;
  }

  if (config.type === "cp-mv-install") {
    const positional = nonFlagArgs(compact.slice(1));
    if (positional.length >= 2) {
      writes.push({ kind: command, path: positional[positional.length - 1] });
    }
    return writes;
  }

  if (config.type === "every-non-flag") {
    for (const token of nonFlagArgs(compact.slice(1))) {
      writes.push({ kind: command, path: token });
    }
    return writes;
  }

  if (config.type === "chmod") {
    const positional = nonFlagArgs(compact.slice(1));
    for (const token of positional.slice(1)) {
      writes.push({ kind: "chmod", path: token });
    }
    return writes;
  }

  if (config.type === "chown") {
    const positional = nonFlagArgs(compact.slice(1));
    for (const token of positional.slice(1)) {
      writes.push({ kind: "chown", path: token });
    }
    return writes;
  }

  if (config.type === "ln") {
    const positional = nonFlagArgs(compact.slice(1));
    const target = positional[positional.length - 1];
    if (target) writes.push({ kind: "ln", path: target });
    return writes;
  }

  if (config.type === "dd") {
    for (const arg of compact.slice(1)) {
      const match = /^of=(.+)$/.exec(arg);
      if (match) writes.push({ kind: "dd", path: match[1] });
    }
    return writes;
  }

  if (command === "tee") {
    const positional = nonFlagArgs(compact.slice(1));
    for (const token of positional) {
      writes.push({ kind: "tee", path: token });
    }
    return writes;
  }

  return writes;
}

export function detectBashWrites(command) {
  if (typeof command !== "string" || command.length === 0) return [];
  const tokens = tokenize(command);
  const simpleCommands = splitSimpleCommands(tokens);
  const writes = [];
  for (const argv of simpleCommands) {
    const entries = detectForSimpleCommand(argv);
    for (const entry of entries) {
      if (entry.path) writes.push(entry);
    }
  }
  return writes;
}

export function extractWritePaths(command) {
  return detectBashWrites(command).map((entry) => entry.path);
}
