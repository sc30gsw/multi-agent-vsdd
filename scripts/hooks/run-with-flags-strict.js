#!/usr/bin/env node
// Strict (fail-closed) hook runner for mavsdd.
// Forwards to one of the sibling hook handlers identified by the first argument
// and exits non-zero if the handler throws or the handler file is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const handler = process.argv[2];
  if (!handler) {
    console.error("run-with-flags-strict: missing handler argument");
    process.exit(1);
  }
  const handlerPath = path.join(HERE, `${handler}.js`);
  if (!fs.existsSync(handlerPath)) {
    console.error(`run-with-flags-strict: unknown handler ${handler}`);
    process.exit(1);
  }
  try {
    const module = await import(pathToFileURL(handlerPath).href);
    if (typeof module.main !== "function") {
      console.error(`run-with-flags-strict: handler ${handler} does not export main()`);
      process.exit(1);
    }
    const input = await readStdin();
    const payload = input.trim().length > 0 ? JSON.parse(input) : {};
    const result = await module.main(payload);
    if (result && result.decision) {
      process.stdout.write(JSON.stringify(result));
    }
    process.exit(result?.exitCode ?? 0);
  } catch (error) {
    console.error(`run-with-flags-strict(${handler}) failed: ${error.message}`);
    process.exit(1);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    if (process.stdin.isTTY) resolve("");
  });
}

main();
