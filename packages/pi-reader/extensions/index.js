import { writeFile } from "node:fs/promises";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { convertReaderInput, normalizeFormat } from "../src/index.js";

const MAX_INLINE_CHARS = 60_000;

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function (pi) {
  pi.registerTool({
    name: "reader_convert",
    label: "Reader Convert",
    description: "Convert an HTTP(S) URL or compatible local file (HTML, Markdown, text, JSON) to Markdown or JSON. Optionally write the converted content to a file.",
    promptSnippet: "Convert a URL or readable file to Markdown/JSON, optionally saving it to disk.",
    promptGuidelines: [
      "Use reader_convert when the user asks to convert a URL or readable local file to Markdown or JSON.",
      "Set output when the user wants a file created; do not overwrite existing files unless explicitly requested.",
    ],
    parameters: Type.Object({
      input: Type.String({ description: "HTTP(S) URL or local file path to convert." }),
      format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("md"), Type.Literal("json")], { description: "Output format. Defaults to markdown." })),
      output: Type.Optional(Type.String({ description: "Path to write converted content. If omitted, content is returned inline." })),
      overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing output when it already exists. Defaults to false." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
      const params = /** @type {{ input: string, format?: "markdown" | "md" | "json", output?: string, overwrite?: boolean }} */ (rawParams);
      const result = await convertReaderInput({
        input: params.input,
        format: params.format === "md" ? "markdown" : params.format,
        output: params.output,
        overwrite: params.overwrite,
      });
      const response = summarizeResult(result);
      return {
        content: [{ type: "text", text: response }],
        details: {
          format: result.format,
          source: result.source,
          output: result.output,
          metadata: result.metadata,
        },
      };
    },
    renderCall(args) {
      const params = args || {};
      return new Text(`reader_convert ${params.input || ""} → ${params.format || "markdown"}${params.output ? ` (${params.output})` : ""}`, 0, 0);
    },
  });

  pi.registerCommand("reader", {
    description: "Convert a URL/file to Markdown or JSON. Usage: /reader <input> [--format markdown|json] [--output path] [--overwrite]",
    handler: async (args, ctx) => {
      const options = parseCommandArgs(args || "");
      if (!options.input) {
        ctx.ui.notify("Usage: /reader <input> [--format markdown|json] [--output path] [--overwrite]", "info");
        return;
      }
      const result = await convertReaderInput({ ...options, input: options.input });
      if (result.output) {
        ctx.ui.notify(`Wrote ${result.format} to ${result.output}`, "info");
        return;
      }
      const suffix = result.format === "json" ? "json" : "md";
      const path = `reader-output.${suffix}`;
      await writeFile(path, result.text, "utf8");
      ctx.ui.notify(`No --output provided; wrote ${path}`, "info");
    },
  });
}

/** @param {{ text: string, output?: string, format: string, source: string, metadata: Record<string, unknown> }} result */
function summarizeResult(result) {
  const header = [
    `format: ${result.format}`,
    `source: ${result.source}`,
    result.output ? `output: ${result.output}` : undefined,
    result.metadata?.title ? `title: ${String(result.metadata.title)}` : undefined,
  ].filter(Boolean).join("\n");
  if (result.output) return header;
  const text = result.text.length > MAX_INLINE_CHARS ? `${result.text.slice(0, MAX_INLINE_CHARS)}\n\n[truncated]` : result.text;
  return `${header}\n\n${text}`;
}

/** @param {string} args */
export function parseCommandArgs(args) {
  const tokens = tokenize(args);
  /** @type {{ input?: string, format?: "markdown" | "json", output?: string, overwrite?: boolean }} */
  const options = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--format" || token === "-f") {
      options.format = normalizeFormat(tokens[++i]);
    } else if (token === "--output" || token === "-o") {
      options.output = tokens[++i];
    } else if (token === "--overwrite") {
      options.overwrite = true;
    } else if (!options.input) {
      options.input = token;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  return options;
}

/** @param {string} input */
function tokenize(input) {
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error("Unclosed quote in command arguments.");
  if (current) tokens.push(current);
  return tokens;
}
