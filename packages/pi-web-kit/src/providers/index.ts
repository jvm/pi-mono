import { validateFetchProvider, validateSearchProvider } from "../config.js";
import type { FetchProvider, SearchProvider, WebKitConfig } from "../types.js";
import { BraveProvider } from "./brave.js";
import { ExaMcpProvider } from "./exa-mcp.js";
import { ExaProvider } from "./exa.js";
import { FirecrawlProvider } from "./firecrawl.js";
import { MarkdownNewProvider } from "./markdown-new.js";
import { TinyFishProvider } from "./tinyfish.js";

export function createSearchProvider(config: WebKitConfig): SearchProvider {
  validateSearchProvider(config.provider_search);
  switch (config.provider_search) {
    case "exa_mcp": return new ExaMcpProvider(config);
    case "exa": return new ExaProvider(config);
    case "tinyfish": return new TinyFishProvider(config);
    case "brave": return new BraveProvider(config);
    case "firecrawl": return new FirecrawlProvider(config);
  }
}

export function createFetchProvider(config: WebKitConfig): FetchProvider {
  validateFetchProvider(config.provider_fetch);
  switch (config.provider_fetch) {
    case "exa_mcp": return new ExaMcpProvider(config);
    case "exa": return new ExaProvider(config);
    case "tinyfish": return new TinyFishProvider(config);
    case "markdown_new": return new MarkdownNewProvider(config);
    case "firecrawl": return new FirecrawlProvider(config);
  }
}
