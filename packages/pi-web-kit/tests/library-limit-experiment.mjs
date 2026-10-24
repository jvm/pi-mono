// Investigation only; not part of the test suite or published package.
// Usage: node --import tsx packages/pi-web-kit/tests/library-limit-experiment.mjs /path/to/@earendil-works/pi-ai
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import extension from "../extensions/index.ts";

const runtimeRoot = process.argv[2];
if (!runtimeRoot) throw new Error("Pass the installed @earendil-works/pi-ai package directory.");
const load = path => import(pathToFileURL(resolve(runtimeRoot, "dist", path)).href);
const { stream: responses } = await load("api/openai-responses.js");
const { stream: anthropic } = await load("api/anthropic-messages.js");
const { validateToolArguments } = await load("utils/validation.js");
const version = JSON.parse(readFileSync(resolve(runtimeRoot, "package.json"), "utf8")).version;
const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-library-limit-"));
const environment = {
  PI_TELEMETRY: "0",
  PI_CODING_AGENT_DIR: cwd,
  CONTEXT7_API_KEY: "synthetic-context7-key",
};
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);

try {
  const tools = [];
  let sessionStart;
  extension({
    registerFlag() {},
    getFlag() {},
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { if (name === "session_start") sessionStart = handler; },
  });
  sessionStart({}, { cwd, isProjectTrusted: () => false });
  const original = tools.find(tool => tool.name === "library_docs");
  assert.ok(original);

  // Persisted declarations are plain JSON in Pi. Do not clone execute/render functions.
  const declaration = {
    name: original.name,
    description: original.description,
    parameters: JSON.parse(JSON.stringify(original.parameters)),
  };
  const variants = Object.fromEntries(
    ["baseline", "strict", "strictEnum", "renamed", "explicitDefault"]
      .map(name => [name, structuredClone(declaration)]),
  );
  for (const name of ["strict", "strictEnum"]) {
    variants[name].constrainedSampling = { type: "json_schema", strict: "prefer" };
  }
  const enumLimit = variants.strictEnum.parameters.properties.limit;
  enumLimit.enum = Array.from({ length: 20 }, (_, index) => index + 1);
  delete enumLimit.minimum;
  delete enumLimit.maximum;
  const renamedProperties = variants.renamed.parameters.properties;
  renamedProperties.maxSnippets = renamedProperties.limit;
  delete renamedProperties.limit;
  variants.explicitDefault.parameters.properties.limit.default = 10;

  // Synthetic models exercise serialization, not live provider acceptance or accuracy.
  const baseModel = {
    id: "synthetic-probe",
    name: "Synthetic probe",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 1024,
    compat: {
      supportsStrictMode: true,
      supportsAdditionalTools: true,
      supportsMidConvoSystemMessages: true,
    },
  };
  const providers = {
    responses: { stream: responses, model: baseModel },
    responsesWithoutStrict: {
      stream: responses,
      model: { ...baseModel, compat: { ...baseModel.compat, supportsStrictMode: false } },
    },
    anthropic: {
      stream: anthropic,
      model: {
        ...baseModel,
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        compat: { supportsStrictTools: true, supportsEagerToolInputStreaming: true },
      },
    },
  };
  let networkAttempts = 0;
  console.log(`Pi AI ${version}; serializer-only probe; no live model calls`);
  for (const [name, tool] of Object.entries(variants)) {
    const field = name === "renamed" ? "maxSnippets" : "limit";
    const args = { libraryName: "OpenAI API", query: "compaction" };
    assert.throws(() => validateToolArguments(tool, {
      name: tool.name, arguments: { ...args, [field]: 6000 },
    }));
    const nullable = Object.fromEntries(Object.keys(tool.parameters.properties).map(key => [key, null]));
    Object.assign(nullable, args);
    const normalized = validateToolArguments(tool, { name: tool.name, arguments: nullable });
    assert.deepEqual(normalized, args, "Pi must normalize optional nulls before execution");

    for (const [provider, { stream, model }] of Object.entries(providers)) {
      const context = { messages: [
        { role: "system", content: "Serialization probe", toolsAdded: [tool], timestamp: 0 },
        { role: "user", content: "probe", timestamp: 1 },
      ] };
      let payload;
      const result = await stream(model, context, {
        apiKey: "synthetic-provider-key",
        fetch: async () => { networkAttempts++; throw new Error("Network forbidden"); },
        onPayload(value) { payload = value; throw new Error("Serialization complete"); },
      }).result();
      assert.ok(payload, result.errorMessage);
      const wireTool = provider === "anthropic"
        ? payload.tools[0]
        : (payload.input.find(item => item.type === "additional_tools")?.tools ?? payload.tools)[0];
      const schema = wireTool.parameters ?? wireTool.input_schema;
      const expectedStrict = provider === "responses"
        ? name === "strict" || name === "strictEnum"
        : provider === "anthropic" && name === "strictEnum";
      assert.equal(wireTool.strict ?? false, expectedStrict);
      if (provider === "responsesWithoutStrict") assert.deepEqual(schema, tool.parameters);
      console.log(JSON.stringify({
        variant: name,
        provider,
        strict: wireTool.strict ?? false,
        schemaBytes: Buffer.byteLength(JSON.stringify(schema)),
        field: schema.properties[field],
      }));
    }
  }
  assert.equal(networkAttempts, 0);
  console.log("15 payloads checked; optional nulls normalized; 6000 rejected locally; network requests: 0");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(cwd, { recursive: true, force: true });
}
