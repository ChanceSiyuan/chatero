import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_SOURCE = join(CORE_ROOT, "protocol", "chatero-core.protocol.json");
const DEFAULT_JAVASCRIPT = join(CORE_ROOT, "generated", "protocol.mjs");
const DEFAULT_DECLARATIONS = join(CORE_ROOT, "generated", "protocol.d.ts");
const DEFAULT_GECKO_JAVASCRIPT = resolve(CORE_ROOT, "..", "..", "chrome", "content", "zotero", "modules", "chateroCoreProtocol.mjs");
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "protocolVersion",
  "maxFrameBytes",
  "defaultDeadlineMs",
  "capabilities",
  "methods",
  "types",
]);
const METHOD_FIELDS = new Set(["name", "capability", "paramsType", "resultType"]);
const TYPE_FIELDS = new Set(["kind", "fields"]);
const PRIMITIVES = new Set(["boolean", "number", "string", "unknown"]);

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
    throw new Error(`${label} must be a TypeScript identifier`);
  }
}

function parseFieldType(value, knownTypes, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a type string`);
  }
  const array = value.endsWith("[]");
  const base = array ? value.slice(0, -2) : value;
  if (!PRIMITIVES.has(base) && !knownTypes.has(base)) {
    throw new Error(`${label} references unknown type ${base}`);
  }
  return array ? `ReadonlyArray<${base}>` : base;
}

export function validateProtocolContract(contract) {
  assertExactFields(contract, TOP_LEVEL_FIELDS, "protocol");
  if (contract.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  if (typeof contract.protocolVersion !== "string" || !/^\d+\.\d+$/.test(contract.protocolVersion)) {
    throw new Error("protocolVersion must use major.minor form");
  }
  if (!Number.isSafeInteger(contract.maxFrameBytes) || contract.maxFrameBytes < 1024 || contract.maxFrameBytes > 16 * 1024 * 1024) {
    throw new Error("maxFrameBytes must be an integer from 1024 through 16777216");
  }
  if (!Number.isSafeInteger(contract.defaultDeadlineMs) || contract.defaultDeadlineMs < 10 || contract.defaultDeadlineMs > 120000) {
    throw new Error("defaultDeadlineMs must be an integer from 10 through 120000");
  }
  if (!Array.isArray(contract.capabilities)) throw new Error("capabilities must be an array");
  const capabilitySet = new Set();
  for (const capability of contract.capabilities) {
    if (typeof capability !== "string" || !/^[a-z][a-z-]*:[a-z][a-z-]*$/.test(capability)) {
      throw new Error(`invalid capability ${capability}`);
    }
    if (capabilitySet.has(capability)) throw new Error(`duplicate capability ${capability}`);
    capabilitySet.add(capability);
  }
  assertExactFields(contract.types, new Set(Object.keys(contract.types || {})), "types");
  const knownTypes = new Set(Object.keys(contract.types));
  for (const [name, descriptor] of Object.entries(contract.types)) {
    assertIdentifier(name, `type ${name}`);
    assertExactFields(descriptor, TYPE_FIELDS, `type ${name}`);
    if (descriptor.kind !== "object") throw new Error(`type ${name} kind must equal object`);
    if (!descriptor.fields || typeof descriptor.fields !== "object" || Array.isArray(descriptor.fields)) {
      throw new Error(`type ${name} fields must be an object`);
    }
    for (const [rawField, fieldType] of Object.entries(descriptor.fields)) {
      const field = rawField.endsWith("?") ? rawField.slice(0, -1) : rawField;
      assertIdentifier(field, `field ${name}.${rawField}`);
      parseFieldType(fieldType, knownTypes, `field ${name}.${rawField}`);
    }
  }
  if (!Array.isArray(contract.methods)) throw new Error("methods must be an array");
  const methods = new Set();
  for (const method of contract.methods) {
    assertExactFields(method, METHOD_FIELDS, "method");
    if (typeof method.name !== "string" || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(method.name)) {
      throw new Error(`invalid method ${method.name}`);
    }
    if (methods.has(method.name)) throw new Error(`duplicate method ${method.name}`);
    methods.add(method.name);
    if (method.capability !== null && !capabilitySet.has(method.capability)) {
      throw new Error(`method ${method.name} uses unknown capability ${method.capability}`);
    }
    for (const field of ["paramsType", "resultType"]) {
      if (!knownTypes.has(method[field])) throw new Error(`method ${method.name} uses unknown ${field} ${method[field]}`);
    }
  }
  return contract;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function renderJavaScript(contract) {
  const methodCapabilities = Object.fromEntries(contract.methods.map(method => [method.name, method.capability]));
  const methodTypes = Object.fromEntries(contract.methods.map(method => [method.name, {
    params: method.paramsType,
    result: method.resultType,
  }]));
  return [
    "// Generated by services/zotero-core/scripts/generate-protocol.mjs. Do not edit.",
    `export const SCHEMA_VERSION = ${contract.schemaVersion};`,
    `export const PROTOCOL_VERSION = ${JSON.stringify(contract.protocolVersion)};`,
    `export const MAX_FRAME_BYTES = ${contract.maxFrameBytes};`,
    `export const DEFAULT_DEADLINE_MS = ${contract.defaultDeadlineMs};`,
    `export const CAPABILITIES = Object.freeze(${JSON.stringify([...contract.capabilities].sort(), null, 2)});`,
    `export const METHOD_CAPABILITIES = Object.freeze(${JSON.stringify(stableObject(methodCapabilities), null, 2)});`,
    `export const METHOD_TYPES = Object.freeze(${JSON.stringify(stableObject(methodTypes), null, 2)});`,
    "",
  ].join("\n");
}

function renderDeclarations(contract) {
  const lines = [
    "// Generated by services/zotero-core/scripts/generate-protocol.mjs. Do not edit.",
    `export type CoreCapability = ${[...contract.capabilities].sort().map(JSON.stringify).join(" | ")};`,
    `export type CoreMethod = ${contract.methods.map(method => JSON.stringify(method.name)).sort().join(" | ")};`,
    "",
  ];
  for (const [name, descriptor] of Object.entries(contract.types).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`export interface ${name} {`);
    for (const [rawField, fieldType] of Object.entries(descriptor.fields).sort(([left], [right]) => left.localeCompare(right))) {
      const optional = rawField.endsWith("?");
      const field = optional ? rawField.slice(0, -1) : rawField;
      lines.push(`  readonly ${field}${optional ? "?" : ""}: ${parseFieldType(fieldType, new Set(Object.keys(contract.types)), `field ${name}.${rawField}`)};`);
    }
    lines.push("}", "");
  }
  lines.push(
    "export interface CoreRequestEnvelope<M extends CoreMethod = CoreMethod> {",
    "  readonly id: string;",
    "  readonly method: M;",
    "  readonly params: unknown;",
    "  readonly deadline: number;",
    "  readonly cancellationId?: string;",
    "  readonly profileEpoch?: string;",
    "  readonly sessionToken?: string;",
    "}",
    ""
  );
  return lines.join("\n");
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  }
  catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function generateProtocol({
  sourcePath = DEFAULT_SOURCE,
  javascriptPath = DEFAULT_JAVASCRIPT,
  geckoJavascriptPath = DEFAULT_GECKO_JAVASCRIPT,
  declarationsPath = DEFAULT_DECLARATIONS,
  check = false,
} = {}) {
  const contract = validateProtocolContract(JSON.parse(await readFile(sourcePath, "utf8")));
  const javascript = renderJavaScript(contract);
  const declarations = renderDeclarations(contract);
  if (check) {
    const [actualJavaScript, actualGeckoJavaScript, actualDeclarations] = await Promise.all([
      readFile(javascriptPath, "utf8"),
      readFile(geckoJavascriptPath, "utf8"),
      readFile(declarationsPath, "utf8"),
    ]);
    if (actualJavaScript !== javascript || actualGeckoJavaScript !== javascript || actualDeclarations !== declarations) {
      throw new Error("generated Zotero Core protocol files are stale; run npm run core:generate");
    }
  }
  else {
    await atomicWrite(javascriptPath, javascript);
    await atomicWrite(geckoJavascriptPath, javascript);
    await atomicWrite(declarationsPath, declarations);
  }
  return {
    checked: check,
    methods: contract.methods.length,
    protocolVersion: contract.protocolVersion,
    types: Object.keys(contract.types).length,
  };
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.some(value => value !== "--check")) {
    process.stderr.write(`protocol generation failed: unknown argument ${args.find(value => value !== "--check")}\n`);
    process.exitCode = 1;
  }
  else {
    generateProtocol({ check: args.includes("--check") })
      .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
      .catch(error => {
        process.stderr.write(`protocol generation failed: ${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
