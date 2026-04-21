import fs from "node:fs/promises";
import path from "node:path";

import { validate } from "./schema.mjs";

export class VerdictValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = "VerdictValidationError";
    this.errors = errors;
  }
}

export async function validateVerdictPayload(payload, context = {}) {
  const errors = [];
  const result = await validate("mavsdd-verdict", payload);
  if (!result.valid) {
    for (const entry of result.errors) {
      errors.push({ kind: "schema", path: entry.path, message: entry.message });
    }
  }
  if (context.reviewerId && payload.reviewerId && payload.reviewerId !== context.reviewerId) {
    errors.push({
      kind: "reviewer_mismatch",
      message: `reviewerId mismatch: expected ${context.reviewerId}, got ${payload.reviewerId}`
    });
  }
  if (
    context.iteration !== undefined
    && payload.iteration !== undefined
    && Number(payload.iteration) !== Number(context.iteration)
  ) {
    errors.push({
      kind: "iteration_mismatch",
      message: `iteration mismatch: expected ${context.iteration}, got ${payload.iteration}`
    });
  }
  if (context.scope && payload.scope && context.scope !== payload.scope) {
    errors.push({
      kind: "scope_mismatch",
      message: `scope mismatch: expected ${context.scope}, got ${payload.scope}`
    });
  }
  if (Array.isArray(payload.findings)) {
    payload.findings.forEach((finding, index) => {
      if (finding && typeof finding === "object" && !finding.id) {
        errors.push({
          kind: "finding_missing_id",
          message: `findings[${index}] missing id`
        });
      }
    });
  }
  return errors;
}

export async function validateVerdictFile(absolutePath, context = {}) {
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    return [
      {
        kind: "parse_error",
        message: `failed to parse verdict JSON: ${error.message}`
      }
    ];
  }
  return validateVerdictPayload(payload, context);
}

export async function writeValidationErrors(inboxDir, errors) {
  if (!errors || errors.length === 0) {
    try {
      await fs.rm(path.join(inboxDir, "validation-errors.json"), { force: true });
    } catch {}
    return;
  }
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(
    path.join(inboxDir, "validation-errors.json"),
    `${JSON.stringify(errors, null, 2)}\n`
  );
}
