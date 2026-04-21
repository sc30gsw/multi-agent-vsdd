import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(HERE, "../../schemas");

const registry = new Map();
const rootRegistry = new Map();

export async function loadSchema(schemaId) {
  if (registry.has(schemaId)) {
    return registry.get(schemaId);
  }
  const filePath = path.join(SCHEMAS_DIR, `${schemaId}.schema.json`);
  const body = JSON.parse(await fs.readFile(filePath, "utf8"));
  registry.set(schemaId, body);
  if (body.$id) {
    rootRegistry.set(body.$id, body);
  }
  await preloadReferences(body);
  return body;
}

async function preloadReferences(schema) {
  const refs = collectExternalRefs(schema);
  for (const ref of refs) {
    if (!registry.has(ref) && !rootRegistry.has(ref)) {
      try {
        await loadSchema(ref);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

function collectExternalRefs(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (node.$ref && typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
    out.add(node.$ref);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const entry of value) collectExternalRefs(entry, out);
    } else if (value && typeof value === "object") {
      collectExternalRefs(value, out);
    }
  }
  return out;
}

export function registerSchema(id, schema) {
  registry.set(id, schema);
  if (schema.$id) {
    rootRegistry.set(schema.$id, schema);
  }
  return schema;
}

export async function validate(schemaId, data) {
  const schema = await loadSchema(schemaId);
  const errors = [];
  validateNode(schema, data, "", { rootSchema: schema, errors });
  return { valid: errors.length === 0, errors };
}

export async function assertValid(schemaId, data, label = schemaId) {
  const { valid, errors } = await validate(schemaId, data);
  if (!valid) {
    const message = errors
      .slice(0, 10)
      .map((error) => `${error.path || "(root)"}: ${error.message}`)
      .join("; ");
    throw new Error(`Schema ${label} validation failed: ${message}`);
  }
}

function addError(errors, path, message) {
  errors.push({ path, message });
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "number";
  return typeof value;
}

function resolveRef(ref, context) {
  if (!ref.startsWith("#")) {
    const target = rootRegistry.get(ref) || registry.get(ref);
    if (!target) {
      throw new Error(`Unknown $ref: ${ref}`);
    }
    return target;
  }
  const pointer = ref.slice(1);
  if (pointer === "") return context.rootSchema;
  const segments = pointer.split("/").filter(Boolean);
  let current = context.rootSchema;
  for (const segment of segments) {
    current = current?.[segment];
    if (current === undefined) {
      throw new Error(`Unable to resolve ref ${ref}`);
    }
  }
  return current;
}

function validateNode(schema, data, pathPrefix, context) {
  if (!schema) return;

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, context);
    validateNode(resolved, data, pathPrefix, context);
    return;
  }

  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.includes(typeOf(data))) {
      addError(context.errors, pathPrefix, `expected type ${expected.join("|")}, got ${typeOf(data)}`);
      return;
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => deepEqual(candidate, data))) {
      addError(context.errors, pathPrefix, `value not in enum ${JSON.stringify(schema.enum)}`);
    }
  }

  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      addError(context.errors, pathPrefix, `string length < ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      addError(context.errors, pathPrefix, `string length > ${schema.maxLength}`);
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(data)) {
        addError(context.errors, pathPrefix, `does not match pattern ${schema.pattern}`);
      }
    }
  }

  if (typeof data === "number" || (data !== null && Number.isInteger(data))) {
    if (schema.minimum !== undefined && data < schema.minimum) {
      addError(context.errors, pathPrefix, `value < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      addError(context.errors, pathPrefix, `value > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      addError(context.errors, pathPrefix, `array length < ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      addError(context.errors, pathPrefix, `array length > ${schema.maxItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i += 1) {
        validateNode(schema.items, data[i], `${pathPrefix}[${i}]`, context);
      }
    }
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) {
          addError(context.errors, pathPrefix || "(root)", `missing required property "${key}"`);
        }
      }
    }
    const properties = schema.properties || {};
    for (const [key, value] of Object.entries(data)) {
      const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (properties[key]) {
        validateNode(properties[key], value, nextPath, context);
      } else if (schema.additionalProperties === false) {
        addError(context.errors, nextPath, `unexpected additional property`);
      }
    }
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

export function _internal() {
  return { registry, rootRegistry };
}
