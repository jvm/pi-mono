import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export const FORMATS = ["markdown", "json"];
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

/**
 * @typedef {"markdown" | "json"} ReaderFormat
 * @typedef {{ input: string, format?: ReaderFormat, output?: string, overwrite?: boolean }} ConvertOptions
 */

/** @param {ConvertOptions} options */
export async function convertReaderInput(options) {
  const input = requireNonEmptyString(options.input, "input");
  const format = normalizeFormat(options.format ?? "markdown");
  const source = await loadInput(input);
  const readable = await toReadableDocument(source);
  const rendered = renderReadable(readable, format);

  if (options.output) {
    await writeOutput(options.output, rendered.text, options.overwrite === true);
  }

  return {
    format,
    source: source.source,
    mediaType: source.mediaType,
    output: options.output ? resolve(options.output) : undefined,
    metadata: readable.metadata,
    text: rendered.text,
    json: rendered.json,
  };
}

/** @param {unknown} value */
export function normalizeFormat(value) {
  if (value === "md") return "markdown";
  if (value === "markdown" || value === "json") return value;
  throw new Error("format must be 'markdown' or 'json'.");
}

/** @param {string} input */
export async function loadInput(input) {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return fetchUrl(trimmed);
  const path = resolve(trimmed);
  const buffer = await readFile(path);
  return {
    kind: "file",
    source: pathToFileURL(path).href,
    path,
    mediaType: mediaTypeFromPath(path),
    body: buffer.toString("utf8"),
  };
}

/** @param {string} url */
async function fetchUrl(url) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed.");
  const response = await fetch(parsed, {
    headers: {
      "accept": "text/html,application/xhtml+xml,application/json,text/markdown,text/plain;q=0.9,*/*;q=0.1",
      "user-agent": "pi-reader/0.1",
    },
  });
  if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status} ${response.statusText}`);
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "text/html";
  return { kind: "url", source: parsed.href, mediaType, body: await response.text() };
}

/** @param {string} path */
function mediaTypeFromPath(path) {
  const ext = extname(path).toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) return "text/html";
  if (ext === ".json") return "application/json";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  return "text/plain";
}

/** @param {{ source: string, mediaType: string, body: string }} source */
async function toReadableDocument(source) {
  if (isHtml(source.mediaType, source.source)) return htmlToReadable(source);
  if (isJson(source.mediaType, source.source)) return jsonToReadable(source);
  return textToReadable(source);
}

/** @param {string} mediaType @param {string} source */
function isHtml(mediaType, source) {
  const ext = extname(new URL(source).pathname).toLowerCase();
  return mediaType.includes("html") || HTML_EXTENSIONS.has(ext);
}

/** @param {string} mediaType @param {string} source */
function isJson(mediaType, source) {
  const ext = extname(new URL(source).pathname).toLowerCase();
  return mediaType.includes("json") || ext === ".json";
}

/** @param {{ source: string, body: string }} source */
function htmlToReadable(source) {
  const dom = new JSDOM(source.body, { url: source.source });
  const article = new Readability(dom.window.document).parse();
  const title = article?.title || dom.window.document.title || source.source;
  const html = article?.content || dom.window.document.body?.innerHTML || source.body;
  const markdown = htmlToMarkdown(html);
  const content = title && !markdown.trimStart().startsWith("#") ? `# ${title}\n\n${markdown}` : markdown;
  return {
    metadata: {
      title,
      byline: article?.byline || undefined,
      excerpt: article?.excerpt || undefined,
      siteName: article?.siteName || undefined,
      length: article?.length || content.length,
    },
    content: content.trim(),
  };
}

/** @param {string} html */
function htmlToMarkdown(html) {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.remove(["script", "style", "noscript"]);
  return turndown.turndown(html);
}

/** @param {{ source: string, body: string }} source */
function jsonToReadable(source) {
  const data = JSON.parse(source.body);
  return {
    metadata: { title: source.source, length: source.body.length },
    content: `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
    data,
  };
}

/** @param {{ source: string, body: string }} source */
function textToReadable(source) {
  return {
    metadata: { title: source.source, length: source.body.length },
    content: source.body.trimEnd(),
  };
}

/** @param {{ metadata: Record<string, unknown>, content: string, data?: unknown }} readable @param {ReaderFormat} format */
function renderReadable(readable, format) {
  const json = {
    metadata: readable.metadata,
    content: readable.content,
    data: readable.data,
  };
  if (format === "json") return { text: JSON.stringify(json, null, 2), json };
  return { text: readable.content, json };
}

/** @param {string} output @param {string} text @param {boolean} overwrite */
async function writeOutput(output, text, overwrite) {
  const path = resolve(output);
  if (!overwrite) {
    try {
      await stat(path);
      throw new Error(`Output file already exists: ${path}. Use overwrite to replace it.`);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        // ok
      } else {
        throw error;
      }
    }
  }
  await writeFile(path, text, "utf8");
}

/** @param {unknown} value @param {string} name */
function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}
