import { lookup } from "node:dns/promises";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export const FORMATS = ["markdown", "json"];
export const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

/**
 * @typedef {"markdown" | "json"} ReaderFormat
 * @typedef {{ input: string, format?: ReaderFormat, output?: string, overwrite?: boolean, maxBytes?: number, timeoutMs?: number }} ConvertOptions
 */

/** @param {ConvertOptions} options */
export async function convertReaderInput(options) {
  const input = requireNonEmptyString(options.input, "input");
  const format = normalizeFormat(options.format ?? "markdown");
  const source = await loadInput(input, {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_INPUT_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  });
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

/** @param {string} input @param {{ maxBytes: number, timeoutMs: number }} limits */
export async function loadInput(input, limits = { maxBytes: DEFAULT_MAX_INPUT_BYTES, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }) {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return fetchUrl(trimmed, limits);
  const path = resolve(trimmed);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Input is not a regular file: ${path}`);
  if (info.size > limits.maxBytes) throw new Error(`Input exceeds maximum size of ${limits.maxBytes} bytes.`);
  const buffer = await readFile(path);
  return {
    kind: "file",
    source: pathToFileURL(path).href,
    path,
    mediaType: mediaTypeFromPath(path),
    body: buffer.toString("utf8"),
  };
}

/** @param {string} url @param {{ maxBytes: number, timeoutMs: number }} limits */
async function fetchUrl(url, limits) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed.");
  await assertPublicHttpUrl(parsed);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        "accept": "text/html,application/xhtml+xml,application/json,text/markdown,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": "pi-reader/0.1",
      },
    });
    if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status} ${response.statusText}`);
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > limits.maxBytes) throw new Error(`Response exceeds maximum size of ${limits.maxBytes} bytes.`);
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "text/html";
    return { kind: "url", source: parsed.href, mediaType, body: await readResponseText(response, limits.maxBytes) };
  } finally {
    clearTimeout(timeout);
  }
}

/** @param {URL} url */
async function assertPublicHttpUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported.");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Localhost URLs are not allowed.");
  if (isPrivateAddress(hostname)) throw new Error("Private network URLs are not allowed.");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error("Private network URLs are not allowed.");
}

/** @param {string} address */
function isPrivateAddress(address) {
  if (address.startsWith("[")) address = address.slice(1, -1);
  const kind = isIP(address);
  if (kind === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

/** @param {Response} response @param {number} maxBytes */
async function readResponseText(response, maxBytes) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds maximum size of ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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
