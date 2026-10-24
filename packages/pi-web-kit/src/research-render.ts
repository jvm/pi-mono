import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { singleLine } from "./render-text.js";

type ResearchTool = "library_search" | "library_docs" | "code_search";
type Candidate = { id?: string; title?: string; url?: string; versions?: string[] };
type ResearchDetails = {
  libraryId?: string;
  results?: Candidate[];
  codeSnippetCount?: number;
  infoSnippetCount?: number;
  sources?: string[];
  omittedResultCount?: number;
  omittedContextCharacters?: number;
  omittedNoContentCount?: number;
  omittedCodeSnippetCount?: number;
  omittedInfoSnippetCount?: number;
  truncated?: boolean;
  message?: string;
};

const labels = {
  library_search: { title: "Library search", pending: "Searching libraries…", provider: "Context7" },
  library_docs: { title: "Library documentation", pending: "Looking up library documentation…", provider: "Context7" },
  code_search: { title: "Code search", pending: "Searching code…", provider: "Exa" },
} as const;
const MAX_ITEMS = 20;

/** Bound physical rows, not newline count before wrapping a giant JSON line. */
function rows(lines: string[]): Component {
  return {
    invalidate() {},
    render: width => width <= 0 ? [] : lines.map(line => truncateToWidth(line, width)),
  };
}

function textContent(result: AgentToolResult<unknown>): string {
  return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
}

function quantity(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function researchProgress(kind: ResearchTool) {
  return {
    content: [{ type: "text" as const, text: labels[kind].pending }],
    details: { researchProgress: kind },
  };
}

export function researchRenderers(kind: ResearchTool): ToolRenderers {
  const label = labels[kind];
  return {
    renderCall(args, theme) {
      const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
      const subject = kind === "code_search" ? input.query : input.libraryId ?? input.libraryName;
      return rows([
        `${theme.fg("toolTitle", theme.bold(kind))} ${theme.fg("accent", singleLine(subject) || "…")}`,
      ]);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (context.isError) {
        const lines = textContent(result).split(/\r?\n/).filter(line => line.trim());
        const limit = expanded ? 10 : 1;
        return rows([
          theme.fg("error", `✕ ${label.title} failed`),
          ...lines.slice(0, limit).map(line => theme.fg("error", `  ${singleLine(line)}`)),
          ...(lines.length > limit && expanded ? [theme.fg("muted", "  … more error text omitted")] : []),
        ]);
      }
      if (isPartial) return rows([theme.fg("muted", label.pending)]);

      const details = result.details as ResearchDetails | undefined;
      if (details?.truncated) {
        return rows([
          theme.fg("warning", "⚠ Output limit reached"),
          theme.fg("muted", `  ${singleLine(details.message) || "Refine the request or use smaller limits."}`),
        ]);
      }

      const docs = kind === "library_docs";
      const valid = docs
        ? typeof details?.codeSnippetCount === "number" && typeof details?.infoSnippetCount === "number"
        : Array.isArray(details?.results);
      if (!details || !valid) {
        // Old sessions and other extensions can supply results without our details.
        const lines = textContent(result).split(/\r?\n/).filter(line => line.trim());
        const limit = expanded ? 10 : 1;
        return rows([
          theme.fg("muted", "Result preview"),
          ...lines.slice(0, limit).map(line => theme.fg("muted", `  ${singleLine(line)}`)),
          ...(expanded && lines.length > limit ? [theme.fg("muted", "  … more text omitted")] : []),
        ]);
      }

      const results = details.results ?? [];
      const count = docs ? details.codeSnippetCount! + details.infoSnippetCount! : results.length;
      const empty = docs ? "No documentation found" : kind === "library_search" ? "No matching libraries" : "No code results";
      const summary = docs
        ? `${quantity(details.codeSnippetCount!, "code snippet")} · ${quantity(details.infoSnippetCount!, "text snippet")}`
        : quantity(results.length, kind === "library_search" ? "candidate" : "source");
      const omissions = [
        details.omittedResultCount ? `${quantity(details.omittedResultCount, "source")} omitted` : "",
        details.omittedContextCharacters ? `${details.omittedContextCharacters} context chars omitted` : "",
        details.omittedNoContentCount ? `${quantity(details.omittedNoContentCount, "source")} without excerpts` : "",
        details.omittedCodeSnippetCount ? `${quantity(details.omittedCodeSnippetCount, "code snippet")} omitted` : "",
        details.omittedInfoSnippetCount ? `${quantity(details.omittedInfoSnippetCount, "text snippet")} omitted` : "",
      ].filter(Boolean);
      const lines = [
        theme.fg(count ? "success" : "muted", count ? `✓ ${label.title} complete` : omissions.length ? "Output limit reached" : empty),
        theme.fg("muted", `  ${summary} · ${label.provider}${omissions.length ? " · output reduced" : ""}`),
      ];
      if (!expanded) return rows(lines);
      for (const omission of omissions) lines.push(theme.fg("muted", `  ${omission}`));
      if (details.message) lines.push(theme.fg("muted", `  ${singleLine(details.message)}`));

      // Keep retrieval order; ranking alone is not proof of an official source.
      if (docs) {
        lines.push(theme.fg("accent", `  ${singleLine(details.libraryId)}`));
        const sources = details.sources ?? [];
        for (const source of sources.slice(0, MAX_ITEMS)) lines.push(theme.fg("muted", `  ${singleLine(source)}`));
        if (sources.length > MAX_ITEMS) lines.push(theme.fg("muted", `  … ${sources.length - MAX_ITEMS} more sources`));
      } else {
        for (const [index, item] of results.slice(0, MAX_ITEMS).entries()) {
          const identity = singleLine(kind === "library_search" ? item.id : item.url);
          const title = singleLine(item.title);
          lines.push(theme.fg("accent", `  ${index + 1}. ${title || identity}`));
          if (title && identity) lines.push(theme.fg("muted", `     ${identity}`));
          if (kind === "library_search" && item.versions?.length) {
            const versions = item.versions.slice(0, 2).map(singleLine).join(", ");
            const more = item.versions.length > 2 ? ` · +${item.versions.length - 2} more` : "";
            lines.push(theme.fg("muted", `     versions: ${versions}${more}`));
          }
        }
        if (results.length > MAX_ITEMS) lines.push(theme.fg("muted", `  … ${results.length - MAX_ITEMS} more results`));
      }
      return rows(lines);
    },
  };
}
