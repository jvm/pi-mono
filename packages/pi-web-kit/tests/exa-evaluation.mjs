// Manual, paid smoke/evaluation run. Excluded from the published package and CI.
// From the repo root: node --import tsx packages/pi-web-kit/tests/exa-evaluation.mjs --live
import { pathToFileURL } from "node:url";
import { ExaProvider } from "../src/providers/exa.ts";
import { buildExaSearchBody } from "../src/providers/exa-contract.ts";
import { asText, requestJson } from "../src/http.ts";
import { applySearchContextBudget } from "../src/limits.ts";
import { redactOutput, WEB_OUTPUT_SCHEMAS } from "../src/output.ts";
import { jsonToolResult } from "../extensions/index.ts";

export const CASES = [
  { id: "node-streams", query: "Node.js 22 TypeScript stream/promises pipeline AbortSignal cancellation example" },
  { id: "pydantic-migration", query: "Pydantic v2 migrate validator to field_validator mode before example" },
  { id: "react-actions", query: "React 19 useActionState form action previousState FormData example" },
];
export const MODES = ["code-fresh", "auto", "lite", "dynamic"];
const CONTEXT_TOKENS = 2_000;
const NUM_RESULTS = 5;
const DYNAMIC_BETA = "dynamic-highlights-2026-08-28";
const PURPOSE = "Find concrete implementation examples matching the requested version and operation; prefer primary sources.";

/** Fixed public queries, at most 12 requests, no retries or follow-up fetches. */
export async function evaluateExa(key) {
  if (!key) throw new Error("EXA_API_KEY is required.");
  const config = { apiKeys: { exa: key } };
  const rows = [];
  // Sequential requests avoid making concurrency a hidden latency variable.
  for (const fixture of CASES) {
    for (const mode of MODES) {
      let diagnostic;
      const provider = new ExaProvider(config, value => { diagnostic = value; });
      const started = performance.now();
      try {
        let result;
        let rawCharacters;
        let sourceCount;
        if (mode === "code-fresh") {
          const raw = await provider.searchCode({ query: fixture.query, purpose: PURPOSE, contextTokens: CONTEXT_TOKENS, numResults: NUM_RESULTS });
          rawCharacters = raw.contextCharacters + (raw.omittedContextCharacters ?? 0);
          sourceCount = raw.results.length;
          result = jsonToolResult(raw, WEB_OUTPUT_SCHEMAS.code_search, [key]).structuredContent;
        } else {
          const input = { query: fixture.query, purpose: PURPOSE, numResults: NUM_RESULTS, type: mode === "lite" ? "lite" : "auto" };
          let raw;
          if (mode === "dynamic") {
            const body = buildExaSearchBody(input);
            body.contents.highlights = { dynamic: true };
            const data = await requestJson("https://api.exa.ai/search", {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key, "Exa-Beta": DYNAMIC_BETA },
              body: JSON.stringify(body), timeoutMs: 30_000, redirect: "error",
            });
            // Deliberately separate from stable provider wiring: no beta in production.
            raw = { results: data.results.map(r => ({
              url: r.url, title: r.title, content: asText(r.highlights), contentFormat: "markdown",
            })) };
            diagnostic = { costDollars: data.costDollars?.total };
          } else raw = await provider.search(input);
          rawCharacters = raw.results.reduce((sum, r) => sum + (r.content?.length ?? 0), 0);
          sourceCount = raw.results.length;
          const bounded = applySearchContextBudget(redactOutput(raw.results, [key]), CONTEXT_TOKENS * 4);
          result = jsonToolResult({ provider: "exa", queries: [{
            query: fixture.query, requestedResultLimit: NUM_RESULTS, effectiveResultLimit: NUM_RESULTS,
            requestedContextTokens: CONTEXT_TOKENS, effectiveContextTokens: CONTEXT_TOKENS,
            contextCharacters: bounded.contextCharacters, omittedContextCharacters: bounded.omittedContextCharacters,
            resultCount: bounded.results.length, results: bounded.results,
          }] }, WEB_OUTPUT_SCHEMAS.web_search, [key]).structuredContent;
        }
        if ("truncated" in result) throw new Error("Metadata exceeded output budget.");
        const sources = result.queries?.[0].results ?? result.results;
        const evidence = sources.map(r => r.content ?? "").join("\n");
        rows.push(redactOutput({
          case: fixture.id, mode, ok: true, durationMs: Math.round(performance.now() - started),
          costDollars: diagnostic?.costDollars, sourceCount, rawCharacters,
          returnedCharacters: evidence.length, jsonBytes: Buffer.byteLength(JSON.stringify(result)),
          approximateTokens: Math.ceil(evidence.length / 4),
          // Evidence for human review, not an automated answer-quality score.
          sources: sources?.map(r => ({ url: r.url, excerpt: r.content?.slice(0, 600) })),
        }, [key]));
      } catch {
        // Do not echo transport errors, response bodies, or credentials.
        rows.push({ case: fixture.id, mode, ok: false, durationMs: Math.round(performance.now() - started) });
      }
    }
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--live") {
    console.error("Paid opt-in run: set EXA_API_KEY and pass --live (12 requests, no retries).");
    process.exitCode = 1;
  } else {
    const rows = await evaluateExa(process.env.EXA_API_KEY);
    console.log(JSON.stringify({ date: new Date().toISOString(), contextTokens: CONTEXT_TOKENS, numResults: NUM_RESULTS, rows }, null, 2));
    if (rows.some(row => !row.ok)) process.exitCode = 1;
  }
}
