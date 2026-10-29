import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { resolveConfig } from "../src/config.js";
import { applySearchContextBudget, capSearchResultLimit, DEFAULT_NUM_RESULTS, DEFAULT_SEARCH_CONTEXT_TOKENS, EXA_DATE_PATTERN, MAX_CODE_CONTEXT_TOKENS, MAX_CODE_RESULTS, MAX_EXA_AGE_HOURS, MAX_EXA_DATE_CHARACTERS, MAX_EXA_DOMAINS, MAX_EXA_HINT_CHARACTERS, MAX_EXA_QUERY_CHARACTERS, MAX_LIMIT, MAX_NUM_RESULTS, MAX_OFFSET, MAX_QUERY_COUNT, MAX_SEARCH_CONTEXT_TOKENS, MAX_URL_COUNT, MAX_URL_LENGTH, TINYFISH_MAX_PAGE } from "../src/limits.js";
import { createCodeSearchProvider, createContext7Provider, createSearchProvider } from "../src/providers/index.js";
import type { FetchProviderName, SearchProviderName } from "../src/types.js";
import { normalizeUrlInput } from "../src/urls.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { projectOutput, redactOutput, redactText, WEB_OUTPUT_SCHEMAS, WEB_TOOL_METADATA } from "../src/output.js";
import { fetchWithCache, type FetchProgressEvent } from "../src/fetch.js";
import { boundStructuredResult } from "../src/output-budget.js";
import { parseInteger } from "../src/validation.js";
import { singleLine } from "../src/render-text.js";
import { researchProgress, researchRenderers } from "../src/research-render.js";
import { ProviderRequestError } from "../src/http.js";
import { buildExaSearchBody } from "../src/providers/exa-contract.js";
import { WEB_TOOLS, names, readRegistration, directSelection, type Exposure, type ExposureState, type Registration } from "../src/exposure.js";

// Preserve existing test/library entry points while keeping orchestration in src.
export { buildCacheKey, fetchWithCache, pageSlice } from "../src/fetch.js";

const REGISTERED_TOOLS_ENTRY = "pi-web-kit:registered-tools";

function disabledBySettings(pi: ExtensionAPI, name: string): boolean {
  const settings = pi.getSettings?.().defaultTools;
  return Array.isArray(settings)
    && settings.filter(entry => entry === `+${name}` || entry === `-${name}`).at(-1) === `-${name}`;
}

function codemodeActive(pi: ExtensionAPI): boolean {
  return pi.getActiveTools?.().includes("codemode") ?? false;
}

export default function (pi: ExtensionAPI) {
  void reportInstallTelemetry();
  pi.registerFlag("web-provider-search", {
    description: "Temporary pi-web-kit search provider override (exa, tinyfish, brave, firecrawl)",
    type: "string",
  });
  pi.registerFlag("web-provider-fetch", {
    description: "Temporary pi-web-kit fetch provider override (exa, tinyfish, markdown_new, firecrawl)",
    type: "string",
  });

  let registeredConfig = "";
  let remembered: ExposureState | undefined;
  function syncTools(ctx: ExtensionContext, reload = false, restore = false) {
    const startupConfig = runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx));
    const exposure: Exposure = !startupConfig.enabled ? "hidden" : codemodeActive(pi) ? "deferred" : "direct";
    const available = [
      "web_search", "web_fetch",
      ...(startupConfig.apiKeys.context7 ? ["library_search", "library_docs"] : []),
      ...(startupConfig.apiKeys.exa ? ["code_search"] : []),
    ];
    const history = registrationHistory(ctx);
    const previous: Registration | undefined = history ?? remembered ?? (reload ? { version: 1, tools: available } : undefined);
    const defaults = pi.getSettings?.().defaultTools;
    const positive = names((Array.isArray(defaults) ? defaults : [])
      .filter(entry => typeof entry === "string" && entry.startsWith("+") && !disabledBySettings(pi, entry.slice(1))).map(entry => entry.slice(1)));
    const restoring = !registeredConfig || restore;
    let active = pi.getActiveTools?.() ?? [];
    let selected = directSelection(previous, active, available, positive, name => disabledBySettings(pi, name), !restoring && !!pi.getActiveTools);
    const signatureFor = () => JSON.stringify([toolConfigSignature(startupConfig), exposure, selected, pi.getSettings?.().defaultTools]);
    // Startup and tree restoration can leave transcript tools pending behind
    // hidden/missing definitions from the previous branch. Register before
    // reading that loadout, and prefer the saved selection over a partial one.
    if (restoring) {
      registerTools(pi, startupConfig, exposure, new Set(previous?.tools), new Set(selected), syncTools);
      registeredConfig = signatureFor();
      active = pi.getActiveTools?.() ?? [];
      selected = directSelection(previous, active, available, positive, name => disabledBySettings(pi, name), false);
    }
    const signature = signatureFor();
    if (signature !== registeredConfig) registerTools(pi, startupConfig, exposure, new Set(previous?.tools), new Set(selected), syncTools);
    const allowed = (name: string) => available.includes(name) && !disabledBySettings(pi, name) && selected.includes(name);
    // Preserve native discovery activation within codemode, but do not mistake
    // an older direct tree snapshot for an explicit deferred activation.
    const sameBranchPolicy = history?.exposure === exposure || (!ctx.sessionManager && previous?.exposure === exposure);
    const declared = exposure === "hidden" ? [] : exposure === "direct" ? selected.filter(allowed)
      : sameBranchPolicy ? (restoring ? previous?.declared ?? active : active).filter(allowed) : [];
    if (pi.getActiveTools && pi.setActiveTools) {
      const current = pi.getActiveTools();
      if (JSON.stringify(names(current)) !== JSON.stringify(names(declared))) {
        pi.setActiveTools([...current.filter(name => !WEB_TOOLS.has(name)), ...declared]);
      }
    }
    remembered = { version: 2, tools: names([...(previous?.tools ?? []), ...available]), exposure,
      directActive: selected, declared: names(pi.getActiveTools?.() ?? declared), positive };
    if (JSON.stringify(history) !== JSON.stringify(remembered)) pi.appendEntry?.(REGISTERED_TOOLS_ENTRY, remembered);
    registeredConfig = signature;
  }
  pi.on("session_start", (event, ctx) => syncTools(ctx, event.reason === "reload"));
  pi.on("before_agent_start", (event, ctx) => {
    syncTools(ctx);
    // Native codemode deliberately omits deferred namespaces from its catalog.
    // Advertise the route, not the schemas, using one composable prompt section.
    const deferred = pi.getAllTools?.().filter(tool => WEB_TOOLS.has(tool.name) && tool.exposure === "deferred").map(tool => tool.name) ?? [];
    if (deferred.length) {
      event.systemPromptOptions.sections.web_research = `For web research with active codemode: ${deferred.join(", ")}. Use await describeNamespace("web") or await searchTools(query, {namespace:"web"}), then await describeTool(name) for provider-specific inputs and typed results. Provider charges and existing approvals still apply.`;
    } else delete event.systemPromptOptions.sections.web_research;
  });
  pi.on("turn_start", (_event, ctx) => syncTools(ctx));
  pi.on("tool_call", (event, ctx) => {
    if (WEB_TOOLS.has(event.toolName) || event.toolName === "codemode" || event.toolName === "tool_search") syncTools(ctx);
  });
  pi.on("tool_result", (_event, ctx) => { syncTools(ctx); });
  pi.on("session_tree", (_event, ctx) => syncTools(ctx, false, true));
  pi.on("session_shutdown", (_event, ctx) => syncTools(ctx));
}

function registrationHistory(ctx: ExtensionContext): Registration | undefined {
  const entry = ctx.sessionManager?.getBranch().filter(item => item.type === "custom" && item.customType === REGISTERED_TOOLS_ENTRY).at(-1);
  return entry?.type === "custom" ? readRegistration(entry.data) : undefined;
}

function registerTools(pi: ExtensionAPI, startupConfig: ReturnType<typeof resolveConfig>, exposure: Exposure, previouslyRegistered: ReadonlySet<string>, selected: ReadonlySet<string>, synchronize: (ctx: ExtensionContext) => void) {
  type DataTool = Omit<ToolDefinition, "execute"> & {
    execute(...args: Parameters<ToolDefinition["execute"]>): Promise<unknown>;
  };
  const register = (tool: DataTool) => {
    const available = !((tool.name.startsWith("library_") && !startupConfig.apiKeys.context7)
      || (tool.name === "code_search" && !startupConfig.apiKeys.exa));
    const selectedExposure = !available || disabledBySettings(pi, tool.name) ? "hidden"
      : exposure === "deferred" && !selected.has(tool.name) ? "direct" : exposure;
    pi.registerTool({
      ...WEB_TOOL_METADATA,
      ...tool,
      // Pi restores active/pending names on reload. Only first availability
      // uses the default; re-registration cannot undo manual deactivation.
      exposure: selectedExposure,
      defaultActive: selectedExposure === "direct" && !previouslyRegistered.has(tool.name),
      outputSchema: WEB_OUTPUT_SCHEMAS[tool.name],
      async execute(id, args, signal, onUpdate, ctx) {
        const config = runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx));
        if (!config.enabled || disabledBySettings(pi, tool.name)) throw new Error("Web tool is disabled.");
        // Pi resolves an executor before tool_call hooks finish. A later hook
        // can change the loadout, so an old deferred executor must recheck the
        // live policy before starting a provider request.
        synchronize(ctx);
        if (pi.getAllTools && pi.getActiveTools) {
          const current = pi.getAllTools().find(item => item.name === tool.name);
          if (!current || current.exposure === "hidden" || (current.exposure === "direct" && !pi.getActiveTools().includes(tool.name))) {
            throw new Error("Web tool is unavailable.");
          }
        }
        if (selectedExposure === "hidden") throw new Error("Web tool is unavailable.");
        const secrets = Object.values(config.apiKeys);
        try {
          const result = await tool.execute(id, args, signal,
            onUpdate ? update => onUpdate(redactOutput(update, secrets)) : undefined, ctx);
          // Providers may return aborted fetches as per-page failures.
          if (signal?.aborted) throw new Error("Web tool cancelled.");
          return jsonToolResult(result, WEB_OUTPUT_SCHEMAS[tool.name], secrets);
        } catch (error) {
          if (signal?.aborted) throw new Error("Web tool cancelled.");
          throw new Error(redactText(error instanceof Error ? error.message : "Web tool failed.", secrets).slice(0, 1000));
        }
      },
    });
  };
  register({
    name: "web_search",
    label: "Web Search",
    description: buildSearchDescription(startupConfig.provider_search),
    promptSnippet: startupConfig.apiKeys.context7
      ? "Search the live web for current events, news, and non-library topics."
      : "Find current or external web information.",
    promptGuidelines: [
      startupConfig.apiKeys.context7
        ? "Use web_search for current events, news, and non-library topics."
        : "Use web_search to find current or external web information.",
      ...(startupConfig.apiKeys.context7
        ? ["Prefer library_docs over web_search for versioned library/framework/SDK documentation."]
        : []),
    ],
    parameters: buildSearchSchema(startupConfig.provider_search),
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as Record<string, any>;
      const queries = normalizeQueries(params);
      if (queries.length === 0) throw new Error("web_search requires query or queries.");

      const config = runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx));
      assertProviderUnchanged("web_search", startupConfig.provider_search, config.provider_search);
      const requestedResultLimit = parseInteger(
        params.numResults ?? (config.provider_search === "brave" ? params.maxUrls : undefined),
        DEFAULT_NUM_RESULTS,
        "numResults",
        1,
      );
      const effectiveResultLimit = capSearchResultLimit(config.provider_search, requestedResultLimit);
      const requestedContextTokens = params.contextTokens == null ? undefined : parseInteger(params.contextTokens, 0, "contextTokens", 1);
      const effectiveContextTokens = Math.min(requestedContextTokens ?? DEFAULT_SEARCH_CONTEXT_TOKENS, MAX_SEARCH_CONTEXT_TOKENS);
      const inputs = queries.map(query => ({ ...params, query, numResults: effectiveResultLimit,
        contextTokens: requestedContextTokens == null ? undefined : effectiveContextTokens }));
      // Validate the entire Exa batch before the first request, not query by query.
      if (config.provider_search === "exa") inputs.forEach(input => buildExaSearchBody(input));
      const provider = createSearchProvider(config, diagnostic => pi.events?.emit("pi-web-kit:exa-diagnostics", diagnostic));
      const grouped = [];
      const progress = createProgress("search", config.provider_search, queries);
      emitProgress(onUpdate, progress);
      for (const input of inputs) {
        const { query } = input;
        markProgressCurrent(progress, query);
        emitProgress(onUpdate, progress);
        let result;
        try { result = await provider.search(input, signal); }
        catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof ProviderRequestError)) throw error;
          grouped.push({ query, status: "failed", requestedResultLimit, effectiveResultLimit,
            requestedContextTokens, effectiveContextTokens, contextCharacters: 0, resultCount: 0, results: [],
            error: { code: "provider_request_failed", message: error.message.slice(0, 256) } });
          markProgressDone(progress, query, "provider request failed");
          emitProgress(onUpdate, progress);
          continue;
        }
        signal?.throwIfAborted();
        const bounded = applySearchContextBudget(redactOutput(result.results, Object.values(config.apiKeys)), effectiveContextTokens * 4);
        grouped.push({
          query,
          status: "success",
          requestedResultLimit,
          effectiveResultLimit: result.effectiveResultLimit ?? effectiveResultLimit,
          requestedContextTokens,
          effectiveContextTokens,
          contextCharacters: bounded.contextCharacters,
          ...(bounded.omittedContextCharacters ? { omittedContextCharacters: bounded.omittedContextCharacters } : {}),
          resultCount: bounded.results.length,
          results: bounded.results,
          ...(result.notices ? { notices: result.notices } : {}),
          ...(result.omittedNoticeCount ? { omittedNoticeCount: result.omittedNoticeCount } : {}),
        });
        markProgressDone(progress, query, `${bounded.results.length} results`);
        emitProgress(onUpdate, progress);
      }
      signal?.throwIfAborted();
      const failed = grouped.filter(query => query.status === "failed").length;
      const result = { provider: config.provider_search,
        status: failed === grouped.length ? "failed" : failed ? "partial" : "success", queries: grouped };
      return result;
    },
    renderCall(args, theme) {
      return new Text(renderWebCall("search", args as Record<string, any>, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderWebResult("search", result, options, theme, context);
    },
  });

  register({
    name: "web_fetch",
    label: "Web Fetch",
    description: buildFetchDescription(startupConfig.provider_fetch),
    promptSnippet: "Read page content from URL(s), with offset/limit for long pages.",
    promptGuidelines: ["Use web_fetch when the user provides URLs or asks to read page content."],
    parameters: buildFetchSchema(startupConfig.provider_fetch),
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as Record<string, any>;
      const urls = normalizeUrls(params);
      if (urls.length === 0) throw new Error("web_fetch requires url or urls.");
      if (urls.length > 1 && params.offset != null && params.offset !== 0) {
        throw new Error("web_fetch offset range reads require a single url, not urls.");
      }

      const config = runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx));
      assertProviderUnchanged("web_fetch", startupConfig.provider_fetch, config.provider_fetch);
      const progress = createProgress("fetch", config.provider_fetch, urls);
      const result = await fetchWithCache(config.provider_fetch, params, urls, signal, config, (event) => {
        updateFetchProgress(progress, event);
        emitProgress(onUpdate, progress);
      });
      return result;
    },
    renderCall(args, theme) {
      return new Text(renderWebCall("fetch", args as Record<string, any>, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderWebResult("fetch", result, options, theme, context);
    },
  });

  if (startupConfig.apiKeys.context7 || exposure === "hidden" || previouslyRegistered.has("library_search")) {
    register({
      name: "library_search",
      label: "Library Search",
      description: "Resolve library, package, framework, SDK, API, or CLI names to canonical library IDs with version, trust, and snippet metadata. Use when you need to inspect candidate matches (official sources, versions, forks); library_docs resolves names automatically.",
      promptSnippet: "List candidate library IDs; library_docs resolves names on its own.",
      promptGuidelines: ["Use library_search only to inspect matching libraries (official source, versions, forks) before a precise library_docs call.", "Not needed for ordinary doc lookups — library_docs resolves a libraryName for you."],
      parameters: buildLibrarySearchSchema(),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      ...researchRenderers("library_search"),
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as Record<string, any>;
        const libraryName = requiredString(params.libraryName, "libraryName");
        const query = optionalString(params.query, "query") ?? libraryName;
        const limit = parseInteger(params.limit, 10, "limit", 1, MAX_NUM_RESULTS);
        const provider = createContext7Provider(runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx)));
        onUpdate?.(researchProgress("library_search"));
        const result = await provider.searchLibraries({ libraryName, query, fast: params.fast === true, limit }, signal);
        return result;
      },
    });

    register({
      name: "library_docs",
      label: "Library Docs",
      description: "Fetch current, version-aware documentation and code examples for a library. Pass libraryName to resolve it automatically, or a known libraryId.",
      promptSnippet: "Get current, version-aware library/framework/SDK docs and code examples.",
      promptGuidelines: ["Use library_docs for any library, framework, SDK, API, or CLI — even familiar ones like React, Next.js, Prisma, or Express. Training data may be outdated; this returns version-specific docs.", "Prefer library_docs over web_search or your own knowledge for library/API questions. Pass libraryName and query; you rarely need library_search first.", "Documentation snippets are complete, but oversized snippets can be omitted. Check omission counts and refine the query or lower limit when needed."],
      parameters: buildLibraryDocsSchema(),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      ...researchRenderers("library_docs"),
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as Record<string, any>;
        const query = requiredString(params.query, "query");
        const limit = parseInteger(params.limit, 10, "limit", 1, MAX_NUM_RESULTS);
        const provider = createContext7Provider(runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx)));
        onUpdate?.(researchProgress("library_docs"));
        let libraryId = optionalString(params.libraryId, "libraryId");
        if (!libraryId) {
          const libraryName = requiredString(params.libraryName, "libraryName");
          const resolved = await provider.searchLibraries({ libraryName, query, fast: params.fast === true, limit: 1 }, signal);
          libraryId = resolved.results[0]?.id;
          if (!libraryId) throw new Error(`No library found for '${libraryName}'. Try library_search with a more specific name.`);
        }
        const result = await provider.getDocs({ libraryId, query, version: optionalString(params.version, "version"), type: "json", fast: params.fast === true, limit }, signal);
        return result;
      },
    });
  }

  if (startupConfig.apiKeys.exa || exposure === "hidden" || previouslyRegistered.has("code_search")) {
    register({
      name: "code_search",
      label: "Code Search",
      description: "Find practical code examples with Exa Auto and live page fetching. No Lite, cached-only, synthesis, or Agent mode.",
      promptSnippet: "Find fresh, version-specific code examples and implementation guidance.",
      promptGuidelines: [
        "Use code_search for real-world code examples, usage patterns, setup snippets, migrations, and error context from open source.",
        "Include the language, exact dependency version, and operation or error in query; state the task and source preferences in required purpose. A live fetch does not guarantee version relevance.",
        "Code search always uses Auto with maxAgeHours: 0. Read structured results and omission counts. For complete code or missing context, use web_fetch with refresh: true on a cited URL; excerpts need not be complete compilable code.",
        ...(startupConfig.apiKeys.context7 ? ["Prefer library_docs for official API/reference documentation."] : []),
      ],
      parameters: buildCodeSearchSchema(),
      ...researchRenderers("code_search"),
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as Record<string, any>;
        const provider = createCodeSearchProvider(runtimeConfig(pi, ctx.cwd, projectIsTrusted(ctx)), diagnostic => pi.events?.emit("pi-web-kit:exa-diagnostics", diagnostic));
        onUpdate?.(researchProgress("code_search"));
        const result = await provider.searchCode(params as unknown as import("../src/types.js").ExaCodeInput, signal);
        return result;
      },
    });
  }
}

function toolConfigSignature(config: ReturnType<typeof resolveConfig>): string {
  return JSON.stringify({
    search: config.provider_search,
    fetch: config.provider_fetch,
    context7: !!config.apiKeys.context7,
    exa: !!config.apiKeys.exa,
    enabled: config.enabled,
  });
}

type ProgressKind = "search" | "fetch";
type ProgressItem = { label: string; status: "pending" | "current" | "done" | "error"; note?: string; error?: string };
type WebProgress = { kind: ProgressKind; provider: string; total: number; completed: number; items: ProgressItem[] };

const int = (description: string, min: number, max?: number) => Type.Integer({ description, minimum: min, ...(max == null ? {} : { maximum: max }) });

export function buildSearchSchema(provider: SearchProviderName) {
  const exaString = (maxLength: number) => ({ minLength: 1, maxLength, pattern: "\\S" });
  const queryBounds = provider === "exa" ? exaString(MAX_EXA_QUERY_CHARACTERS) : {};
  const props: Record<string, any> = {
    query: Type.Optional(Type.String({ description: "Single search query", ...queryBounds })),
    queries: Type.Optional(Type.Array(Type.String(queryBounds), { description: `Multiple related search queries (max ${MAX_QUERY_COUNT})`, maxItems: MAX_QUERY_COUNT })),
    numResults: Type.Optional(int("Desired results per query; capped by the active provider", 1)),
    contextTokens: Type.Optional(int(provider === "exa" ? "Output context budget for highlights; does not request page text. Use web_fetch for full pages" : "Desired extracted context tokens; capped to the tool output budget and may enable provider extraction", 1)),
    purpose: Type.Optional(Type.String({ description: provider === "exa" ? "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them." : "Optional task/use-case hint when supported by the provider", minLength: 1, maxLength: 2_000, ...(provider === "exa" ? { pattern: "\\S" } : {}) })),
  };
  if (provider === "exa") Object.assign(props, {
    purpose: Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S",
      description: "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them." }),
    includeDomains: Type.Optional(Type.Array(Type.String(exaString(MAX_URL_LENGTH)), { maxItems: MAX_EXA_DOMAINS })),
    excludeDomains: Type.Optional(Type.Array(Type.String(exaString(MAX_URL_LENGTH)), { maxItems: MAX_EXA_DOMAINS })),
    startPublishedDate: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EXA_DATE_CHARACTERS, pattern: EXA_DATE_PATTERN })),
    endPublishedDate: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EXA_DATE_CHARACTERS, pattern: EXA_DATE_PATTERN })),
    startCrawlDate: Type.Optional(Type.String({ description: "Deprecated: Exa ignores crawl-date filters. Rejected locally; publication dates have different semantics." })),
    endCrawlDate: Type.Optional(Type.String({ description: "Deprecated: Exa ignores crawl-date filters. Rejected locally; publication dates have different semantics." })),
    type: Type.Optional(Type.String({ ...exaString(MAX_EXA_HINT_CHARACTERS), description: "Search mode: auto (default), lite (lower cost, cached pages only; no maxAgeHours), or deep. Legacy types remain accepted." })),
    category: Type.Optional(Type.String(exaString(MAX_EXA_HINT_CHARACTERS))),
    maxAgeHours: Type.Optional(int("Maximum Exa cached content age in hours; 0 forces live crawl, -1 disables live crawl. Not supported by lite, even -1", -1, MAX_EXA_AGE_HOURS)),
  });
  if (provider === "tinyfish") Object.assign(props, {
    page: Type.Optional(int("Deprecated starting result page", 0, TINYFISH_MAX_PAGE)),
    location: Type.Optional(Type.String()), language: Type.Optional(Type.String()),
    includeDomains: Type.Optional(Type.Array(Type.String())), excludeDomains: Type.Optional(Type.Array(Type.String())),
    domainType: Type.Optional(Type.Union([Type.Literal("web"), Type.Literal("news"), Type.Literal("research_paper")])),
    afterDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), beforeDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    recencyMinutes: Type.Optional(int("Freshness window in minutes", 1, 5_256_000)),
    pubYearMin: Type.Optional(int("Minimum publication year", 0, 9_999)), pubYearMax: Type.Optional(int("Maximum publication year", 0, 9_999)),
  });
  if (provider === "brave") Object.assign(props, {
    country: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })), searchLang: Type.Optional(Type.String({ minLength: 2, maxLength: 10 })),
    safesearch: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("moderate"), Type.Literal("strict")])),
    freshness: Type.Optional(Type.String()), spellcheck: Type.Optional(Type.Boolean()),
    contextThresholdMode: Type.Optional(Type.Union([Type.Literal("disabled"), Type.Literal("strict"), Type.Literal("balanced"), Type.Literal("lenient")])),
    maxSnippets: Type.Optional(int("Maximum context snippets", 1, 256)),
    maxTokensPerUrl: Type.Optional(int("Maximum context tokens per URL", 512, 8_192)),
    maxSnippetsPerUrl: Type.Optional(int("Maximum context snippets per URL", 1, 100)),
    goggles: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 3 })])),
    maxUrls: Type.Optional(int("Deprecated alias for numResults", 1)),
  });
  if (provider === "firecrawl") Object.assign(props, {
    location: Type.Optional(Type.String()), country: Type.Optional(Type.String()), includeDomains: Type.Optional(Type.Array(Type.String())), excludeDomains: Type.Optional(Type.Array(Type.String())),
    categories: Type.Optional(Type.Array(Type.Union([Type.Literal("research"), Type.Literal("pdf"), Type.Literal("developer")]))),
    tbs: Type.Optional(Type.String()), scrape: Type.Optional(Type.Boolean({ description: "Enable default markdown scrape-on-search" })), scrapeOptions: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Firecrawl scrapeOptions for search." })),
  });
  return Type.Object(props, { additionalProperties: false });
}

export function buildFetchSchema(provider: FetchProviderName) {
  const props: Record<string, any> = {
    url: Type.Optional(Type.String({ description: "Single URL", maxLength: 2048 })),
    urls: Type.Optional(Type.Array(Type.String({ maxLength: 2048 }), { description: `Multiple URLs (max ${MAX_URL_COUNT})`, maxItems: MAX_URL_COUNT })),
    find: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Literal text to find in cached redacted content only. A cache miss does not fetch. Incompatible with offset, limit and refresh." })),
    findCaseSensitive: Type.Optional(Type.Boolean({ description: "Default true. False uses Unicode case-insensitive literal matching." })),
    findFrom: Type.Optional(int("UTF-16 offset for finding continuation, default 0", 0, MAX_OFFSET)),
    offset: Type.Optional(int("Character offset for cached/ranged reads", 0, MAX_OFFSET)),
    limit: Type.Optional(int("Maximum characters to return", 1, MAX_LIMIT)),
    refresh: Type.Optional(Type.Boolean({ description: "Refetch even if cached" })),
    maxAgeMs: Type.Optional(int("Maximum local/provider-cached page age in milliseconds; 0 requests live content where supported", 0)),
  };
  if (provider === "exa") Object.assign(props, { maxAgeHours: Type.Optional(int("Maximum Exa cached content age in hours; 0 forces live crawl, -1 disables live crawl", -1, MAX_EXA_AGE_HOURS)) });
  if (provider === "tinyfish") Object.assign(props, { format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("json")])), links: Type.Optional(Type.Boolean()), imageLinks: Type.Optional(Type.Boolean()) });
  if (provider === "tinyfish") Object.assign(props, {
    purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    ttl: Type.Optional(int("Provider cache freshness tolerance in seconds; 0 prefers live fetch", 0)),
    perUrlTimeoutMs: Type.Optional(int("Per-URL timeout in milliseconds", 1, 110_000)),
    includeSelectors: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20 })),
    excludeSelectors: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20 })),
  });
  if (provider === "markdown_new") Object.assign(props, { method: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("ai"), Type.Literal("browser")])), retainImages: Type.Optional(Type.Boolean()) });
  if (provider === "firecrawl") Object.assign(props, {
    format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("json")])),
    onlyMainContent: Type.Optional(Type.Boolean()), waitFor: Type.Optional(int("Milliseconds to wait", 0, 60_000)), mobile: Type.Optional(Type.Boolean()),
    location: Type.Optional(Type.Object({ country: Type.Optional(Type.String()), languages: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false })),
    maxAge: Type.Optional(int("Maximum cached page age in milliseconds", 0)),
  });
  return Type.Object(props, { additionalProperties: false });
}

export function buildLibrarySearchSchema() {
  return Type.Object({
    libraryName: Type.String({ description: "Library, package, framework, SDK, API, CLI, or product name", minLength: 1, maxLength: 500 }),
    query: Type.Optional(Type.String({ description: "User task/question used for relevance ranking", minLength: 1, maxLength: 500 })),
    fast: Type.Optional(Type.Boolean({ description: "Skip LLM reranking for lower latency" })),
    limit: Type.Optional(int("Maximum libraries to return", 1, MAX_NUM_RESULTS)),
  }, { additionalProperties: false });
}

export function buildLibraryDocsSchema() {
  return Type.Object({
    libraryId: Type.Optional(Type.String({ description: "Canonical library ID, for example /vercel/next.js", minLength: 1, maxLength: 500 })),
    libraryName: Type.Optional(Type.String({ description: "Library name to resolve when libraryId is not known", minLength: 1, maxLength: 500 })),
    query: Type.String({ description: "Specific docs question or coding task", minLength: 1, maxLength: 500 }),
    version: Type.Optional(Type.String({ description: "Optional version/tag to pin, appended as @version", minLength: 1, maxLength: 100 })),
    fast: Type.Optional(Type.Boolean({ description: "Skip LLM reranking for lower latency" })),
    limit: Type.Optional(int("Maximum code and info snippets to return", 1, MAX_NUM_RESULTS)),
  }, { additionalProperties: false });
}

export function buildCodeSearchSchema() {
  return Type.Object({
    query: Type.String({ description: "Coding query with language, exact dependency version, and operation or error", minLength: 1, maxLength: MAX_EXA_QUERY_CHARACTERS, pattern: "\\S" }),
    purpose: Type.String({ description: "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them.", minLength: 1, maxLength: 2_000, pattern: "\\S" }),
    numResults: Type.Optional(int("Source breadth; default 5, maximum 10 to stay within the base search price", 1, MAX_CODE_RESULTS)),
    contextTokens: Type.Optional(int("Local excerpt budget; default 8192. Does not request synthesis or full page text", 1, MAX_CODE_CONTEXT_TOKENS)),
    includeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_URL_LENGTH, pattern: "\\S" }), { maxItems: MAX_EXA_DOMAINS })),
    excludeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_URL_LENGTH, pattern: "\\S" }), { maxItems: MAX_EXA_DOMAINS })),
  }, { additionalProperties: false });
}

function buildSearchDescription(_provider: SearchProviderName): string {
  return "Search the web. Use query or queries; returns compact results grouped by query.";
}

function buildFetchDescription(_provider: FetchProviderName): string {
  return "Fetch URL content. Results are cached by URL/options; use offset/limit to read long pages in chunks.";
}


function normalizeQueries(params: Record<string, any>): string[] {
  const raw = Array.isArray(params.queries) ? params.queries : params.query ? [params.query] : [];
  const queries = [...new Set(raw.map((q) => String(q).trim()).filter(Boolean))];
  if (queries.length > MAX_QUERY_COUNT) throw new Error(`Too many queries: maximum is ${MAX_QUERY_COUNT}.`);
  return queries;
}

function normalizeUrls(params: Record<string, any>): string[] {
  return normalizeUrlInput({ url: params.url, urls: params.urls }, MAX_URL_COUNT);
}

function projectIsTrusted(ctx: { isProjectTrusted?: () => boolean }): boolean {
  return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
}

function runtimeConfig(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  try {
    return resolveConfig(
      { providerSearch: pi.getFlag("web-provider-search"), providerFetch: pi.getFlag("web-provider-fetch") },
      cwd,
      process.env,
      { includeProject: projectTrusted },
    );
  } catch {
    // JSON parse and invalid-provider errors can echo credential-bearing config.
    throw new Error("Web configuration is invalid. Check provider names, flags and config JSON.");
  }
}

export function jsonToolResult(result: unknown, schema?: TSchema, secrets: readonly string[] = []) {
  const publicResult = schema ? projectOutput(schema, result) : result;
  const bounded = boundStructuredResult(redactOutput(publicResult, secrets));
  const text = JSON.stringify(bounded);
  // The model and scripts receive exactly the same bounded, redacted JSON value.
  const structuredContent = JSON.parse(text);
  return { content: [{ type: "text" as const, text }], structuredContent, details: boundedDetails(structuredContent) };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  return requiredString(value, name);
}

function assertProviderUnchanged(tool: string, startup: string, runtime: string) {
  if (startup !== runtime) throw new Error(`${tool} was registered for provider '${startup}' but runtime config resolved '${runtime}'. Restart or reload pi after changing pi-web-kit provider config so tool schemas match the active provider.`);
}

function boundedDetails(value: any): unknown {
  if (value?.queries && Array.isArray(value.queries)) return searchDetails(value);
  if (value?.provider === "context7" && value?.results && Array.isArray(value.results)) return librarySearchDetails(value);
  if (value?.provider === "context7" && value?.codeSnippets && value?.infoSnippets) return libraryDocsDetails(value);
  if (value?.provider === "exa" && value.searchType === "auto") return codeSearchDetails(value);
  if (value?.results && Array.isArray(value.results)) return fetchDetails(value);
  return value;
}

function searchDetails(value: any) {
  return {
    provider: value.provider,
    status: value.status,
    queries: value.queries.map((q: any) => ({
      query: q.query,
      status: q.status,
      error: q.error,
      requestedResultLimit: q.requestedResultLimit,
      effectiveResultLimit: q.effectiveResultLimit,
      requestedContextTokens: q.requestedContextTokens,
      effectiveContextTokens: q.effectiveContextTokens,
      contextCharacters: q.contextCharacters,
      omittedContextCharacters: q.omittedContextCharacters,
      resultCount: (q.results ?? []).length,
      omittedResultCount: q.omittedResultCount,
      results: (q.results ?? []).map((r: any) => ({ title: r.title, url: r.url, siteName: r.siteName, position: r.position })),
    })),
  };
}

function librarySearchDetails(value: any) {
  return {
    provider: value.provider,
    libraryName: value.libraryName,
    resultCount: value.results.length,
    omittedResultCount: value.omittedResultCount,
    results: value.results.map((r: any) => ({ id: r.id, title: r.title, state: r.state, trustScore: r.trustScore, versions: r.versions })),
  };
}

function libraryDocsDetails(value: any) {
  const codeSources = value.codeSnippets.map((s: any) => s.codeId);
  const infoSources = value.infoSnippets.map((s: any) => s.pageId);
  return {
    provider: value.provider,
    libraryId: value.libraryId,
    query: value.query,
    codeSnippetCount: value.codeSnippets.length,
    infoSnippetCount: value.infoSnippets.length,
    omittedCodeSnippetCount: value.omittedCodeSnippetCount,
    omittedInfoSnippetCount: value.omittedInfoSnippetCount,
    message: value.message,
    sources: [...codeSources, ...infoSources].filter(Boolean).slice(0, MAX_NUM_RESULTS),
  };
}

function codeSearchDetails(value: any) {
  return {
    provider: value.provider,
    query: value.query,
    searchType: value.searchType, maxAgeHours: value.maxAgeHours,
    resultCount: value.resultCount, omittedResultCount: value.omittedResultCount,
    contextCharacters: value.contextCharacters, omittedContextCharacters: value.omittedContextCharacters,
    omittedNoContentCount: value.omittedNoContentCount,
    results: value.results.map((r: any) => ({ title: r.title, url: r.url, publishedDate: r.publishedDate })),
  };
}

function fetchDetails(value: any) {
  return {
    provider: value.provider,
    results: value.results.map((r: any) => ({
      url: r.url,
      fetchedUrl: r.fetchedUrl,
      title: r.title,
      format: r.format,
      cached: r.cached,
      refreshed: r.refreshed,
      range: r.range,
      error: r.error,
      ...(r.find ? { find: { count: r.find.count, omittedMatchCount: r.find.omittedMatchCount } } : {}),
    })),
  };
}

function createProgress(kind: ProgressKind, provider: string, labels: string[]): WebProgress {
  return { kind, provider, total: labels.length, completed: 0, items: labels.map((label) => ({ label, status: "pending" })) };
}

function markProgressCurrent(progress: WebProgress, label: string) {
  const item = progress.items.find((i) => i.label === label);
  if (item && item.status === "pending") item.status = "current";
}

function markProgressDone(progress: WebProgress, label: string, note?: string) {
  const item = progress.items.find((i) => i.label === label);
  if (!item) return;
  item.status = "done";
  item.note = note;
  progress.completed++;
}

function markProgressError(progress: WebProgress, label: string, error?: string) {
  const item = progress.items.find((i) => i.label === label);
  if (!item) return;
  item.status = "error";
  item.error = error;
  progress.completed++;
}

function updateFetchProgress(progress: WebProgress, event: FetchProgressEvent) {
  switch (event.status) {
    case "current":
      markProgressCurrent(progress, event.url);
      break;
    case "done":
      markProgressDone(progress, event.url, event.note);
      break;
    case "error":
      markProgressError(progress, event.url, event.error);
      break;
  }
}

function emitProgress(onUpdate: ((patch: any) => void) | undefined, progress: WebProgress) {
  const verb = progress.kind === "search" ? "Searching web" : "Fetching pages";
  onUpdate?.({
    content: [{ type: "text", text: `${verb}: ${progress.completed}/${progress.total}` }],
    details: { progress: cloneProgress(progress) },
  });
}

function cloneProgress(progress: WebProgress): WebProgress {
  return { ...progress, items: progress.items.map((item) => ({ ...item })) };
}

function renderWebCall(kind: ProgressKind, args: Record<string, any>, theme: any): string {
  const title = kind === "search" ? "web_search" : "web_fetch";
  const labels = kind === "search" ? normalizeLabels(args.query, args.queries) : normalizeLabels(args.url, args.urls);
  const summary = labels.length > 1 ? `${labels.length} ${kind === "search" ? "queries" : "URLs"}` : (labels[0] ?? "…");
  return `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", truncateMiddle(summary, 96))}`;
}

function renderWebResult(kind: ProgressKind, result: any, { expanded, isPartial }: any, theme: any, context: any) {
  const progress = result.details?.progress as WebProgress | undefined;
  if (isPartial && progress) {
    startSpinner(context);
    return new Text(renderProgress(progress, theme, spinnerFrame(context), expanded), 0, 0);
  }
  stopSpinner(context);

  const details = result.details as any;
  if (kind === "search" && details?.queries) {
    const total = details.queries.reduce((sum: number, q: any) => sum + (q.resultCount ?? q.results?.length ?? 0), 0);
    const failed = details.queries.filter((q: any) => q.status === "failed").length;
    let text = `${theme.fg(failed ? "warning" : "success", failed ? "Web search completed with failures" : "✅ Web search complete")} ${theme.fg("muted", `${details.queries.length - failed}/${details.queries.length}`)}\n   results: ${total} total`;
    if (expanded) for (const q of details.queries) text += `\n   ${q.status === "failed" ? "✗" : "✓"} ${theme.fg("accent", quote(q.query))} ${theme.fg("muted", q.error?.message ?? `${q.resultCount ?? q.results?.length ?? 0} results`)}`;
    return new Text(text, 0, 0);
  }
  if (kind === "fetch" && details?.results) {
    const ok = details.results.filter((r: any) => !r.error).length;
    const failed = details.results.length - ok;
    let text = failed > 0 ? `${theme.fg("warning", "⚠️ Fetch complete")} ${ok}/${details.results.length} succeeded` : `${theme.fg("success", details.results.length === 1 ? "✅ Page fetched" : "✅ Pages fetched")} ${theme.fg("muted", `${ok}/${details.results.length}`)}`;
    if (expanded) for (const r of details.results) text += `\n   ${r.error ? theme.fg("error", "✕") : theme.fg("success", "✓")} ${theme.fg("accent", truncateMiddle(r.url, 100))}${r.error ? theme.fg("error", ` ${singleLine(r.error)}`) : theme.fg("muted", r.find ? ` ${r.find.count} matches, ${r.find.omittedMatchCount} omitted (cached)` : ` ${r.range?.returned ?? 0}/${r.range?.total ?? 0} chars${r.cached ? " cached" : ""}`)}`;
    return new Text(text, 0, 0);
  }
  const content = result.content?.find?.((c: any) => c.type === "text")?.text ?? "";
  return new Text(singleLine(content), 0, 0);
}

function renderProgress(progress: WebProgress, theme: any, spinner: string, expanded: boolean): string {
  const isSearch = progress.kind === "search";
  const verb = isSearch ? "Searching web" : progress.total === 1 ? "Fetching page" : "Fetching pages";
  let text = `${isSearch ? "🔎" : "🌐"} ${verb}${progress.total > 1 ? `  ${progressBar(progress.completed, progress.total)} ${progress.completed}/${progress.total}` : "…"}`;
  const visible = expanded ? progress.items : progress.items.slice(0, 6);
  const iconMap: Record<string, string> = {
    done: theme.fg("success", "✓"),
    error: theme.fg("error", "✕"),
    current: theme.fg("warning", spinner),
    pending: theme.fg("muted", "·"),
  };
  for (const item of visible) {
    const icon = iconMap[item.status] ?? theme.fg("muted", "·");
    const note = item.error ? theme.fg("error", ` ${singleLine(item.error)}`) : item.note ? theme.fg("muted", ` ${singleLine(item.note)}`) : "";
    text += `\n   ${icon} ${theme.fg(item.status === "pending" ? "muted" : "accent", quote(truncateMiddle(item.label, 100)))}${note}`;
  }
  if (!expanded && progress.items.length > visible.length) text += `\n   ${theme.fg("muted", `… +${progress.items.length - visible.length} more`)}`;
  return text;
}

function startSpinner(context: any) {
  if (context.state?.spinnerTimer) return;
  context.state.spinnerIndex = context.state.spinnerIndex ?? 0;
  context.state.spinnerTimer = setInterval(() => {
    context.state.spinnerIndex = ((context.state.spinnerIndex ?? 0) + 1) % SPINNER.length;
    context.invalidate?.();
  }, 140);
}

function stopSpinner(context: any) {
  if (!context.state?.spinnerTimer) return;
  clearInterval(context.state.spinnerTimer);
  context.state.spinnerTimer = undefined;
}

const SPINNER = ["◐", "◓", "◑", "◒"];

function spinnerFrame(context: any): string {
  return SPINNER[context.state?.spinnerIndex ?? 0] ?? SPINNER[0];
}

function progressBar(completed: number, total: number): string {
  const width = 16;
  const filled = total <= 0 ? 0 : Math.round((completed / total) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function normalizeLabels(single: unknown, multiple: unknown): string[] {
  const raw = Array.isArray(multiple) ? multiple : single ? [single] : [];
  return raw.map((v) => singleLine(String(v))).filter(Boolean);
}

function quote(value: string): string {
  return `"${singleLine(value)}"`;
}

function truncateMiddle(value: string, max: number): string {
  value = singleLine(value);
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
