import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";

const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const string = () => Type.Optional(Type.String());
const number = () => Type.Optional(Type.Number());
const boolean = () => Type.Optional(Type.Boolean());
const truncated = object({ truncated: Type.Literal(true), message: Type.String() });
const output = (schema: TSchema) => Type.Union([schema, truncated]);

// Only explicitly selected fields cross the tool boundary. Provider metadata,
// cache keys, response headers and Context7's untyped `rules` are not a contract.
export const WEB_OUTPUT_SCHEMAS: Record<string, TSchema> = {
  web_search: output(object({
    provider: Type.String(),
    queries: Type.Array(object({
      query: Type.String(), requestedResultLimit: Type.Integer(), effectiveResultLimit: Type.Integer(),
      requestedContextTokens: Type.Optional(Type.Integer()), effectiveContextTokens: Type.Integer(),
      contextCharacters: Type.Integer(), omittedContextCharacters: Type.Optional(Type.Integer()),
      resultCount: Type.Integer(), omittedResultCount: Type.Optional(Type.Integer()),
      results: Type.Array(object({
        url: Type.String(), title: string(), snippet: string(), content: string(),
        contentFormat: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text")])),
        siteName: string(), position: number(),
      })),
    })),
  })),
  web_fetch: output(object({
    provider: Type.String(),
    results: Type.Array(Type.Union([
      object({ url: Type.String(), error: Type.String() }),
      object({
        url: Type.String(), fetchedUrl: Type.String(), title: string(), content: Type.String(),
        format: Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("json")]),
        cached: Type.Boolean(), refreshed: Type.Boolean(),
        range: object({
          offset: Type.Integer(), limit: Type.Integer(), returned: Type.Integer(), total: Type.Integer(),
          truncated: Type.Boolean(), hasPrevious: Type.Boolean(), hasNext: Type.Boolean(),
          nextOffset: Type.Optional(Type.Integer()),
        }),
      }),
    ])),
  })),
  library_search: output(object({
    provider: Type.Literal("context7"), libraryName: Type.String(), query: Type.String(),
    searchFilterApplied: boolean(),
    results: Type.Array(object({
      id: Type.String(), title: string(), description: string(), branch: string(),
      lastUpdateDate: string(), state: string(), totalTokens: number(), totalSnippets: number(),
      stars: number(), trustScore: number(), benchmarkScore: number(),
      versions: Type.Optional(Type.Array(Type.String())),
    })),
  })),
  library_docs: output(object({
    provider: Type.Literal("context7"), libraryId: Type.String(), query: Type.String(),
    codeSnippets: Type.Array(object({
      codeTitle: string(), codeDescription: string(), codeLanguage: string(), codeTokens: number(),
      codeId: string(), pageTitle: string(), sourceFile: string(), isDynamic: boolean(),
      codeList: Type.Optional(Type.Array(object({ language: Type.String(), code: Type.String() }))),
    })),
    infoSnippets: Type.Array(object({
      pageId: string(), breadcrumb: string(), content: Type.String(), contentTokens: number(),
    })),
  })),
  code_search: output(object({
    provider: Type.Literal("exa"), query: Type.String(), response: Type.String(),
    resultsCount: number(), searchTime: number(), outputTokens: number(), requestId: string(),
  })),
};

export const WEB_TOOL_METADATA = {
  namespace: {
    name: "web",
    description: "Bounded web research, library documentation and code examples.",
    instructions: "Keep existing tool names: web_search, web_fetch, library_search, library_docs, code_search. Await describeTool(name) for provider-specific inputs and output types. Calls return objects, not JSON strings. Fetch failures are per-item error strings; check them before using content. A top-level truncated:true/message result asks you to refine the request. Validation, cancellation and request failures reject. Parallel independent reads are supported; provider requests can incur costs. Availability depends on configured providers and active tools. These hints do not grant approval.",
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
} as const;

/** Project to an allowlist before bounding or publishing. Invalid required data fails closed. */
export function projectOutput(schema: TSchema, value: unknown): any {
  const shape = schema as TSchema & {
    anyOf?: TSchema[]; type?: string; properties?: Record<string, TSchema>;
    required?: string[]; items?: TSchema;
  };
  if (shape.anyOf) {
    for (const variant of shape.anyOf) {
      try { return projectOutput(variant, value); } catch { /* try the next declared shape */ }
    }
    throw new Error("Provider returned an invalid result shape.");
  }
  let projected = value;
  if (shape.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    projected = Object.fromEntries(Object.entries(shape.properties ?? {}).flatMap(([key, field]) => {
      if (!Object.hasOwn(value, key) || (value as any)[key] == null) return [];
      try { return [[key, projectOutput(field as TSchema, (value as any)[key])]]; }
      catch {
        if (shape.required?.includes(key)) throw new Error("Provider returned an invalid result shape.");
        return [];
      }
    }));
  } else if (shape.type === "array" && shape.items && Array.isArray(value)) {
    projected = value.map(item => projectOutput(shape.items!, item));
  }
  if (!Check(schema, projected)) throw new Error("Provider returned an invalid result shape.");
  return projected;
}

export function redactText(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("*".repeat(secret.length));
  }
  return redacted
    .replace(/(https?:\/\/)([^\s/@"<>]+)@/gi, (_match, prefix, secret) => `${prefix}${"*".repeat(secret.length)}@`)
    .replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]+)/gi, (_match, prefix, space, secret) => `${prefix}${space}${"*".repeat(secret.length)}`)
    .replace(/([?&](?:api[-_]?key|access[-_]?token|token|secret|password)=)([^&#\s"'<>]+)/gi, (_match, prefix, secret) => `${prefix}${"*".repeat(secret.length)}`);
}

export function redactOutput(value: any, secrets: readonly string[]): any {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactOutput(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactOutput(item, secrets)]));
  }
  return value;
}

/** Provider error bodies are not page content and must not become tool output. */
export function publicPageError(error: unknown): string {
  if (typeof error === "string" && (
    /^Provider request failed \(HTTP \d{3}\)\.$/.test(error)
    || /^Request timed out after \d+ms$/.test(error)
    || /^No content returned(?: by (?:TinyFish|Exa(?: contents endpoint)?))?\.$/.test(error)
    || error === "Provider returned invalid JSON."
  )) return error;
  return "Provider could not fetch this page.";
}
