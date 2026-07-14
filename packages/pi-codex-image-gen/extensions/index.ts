/**
 * Project-local Codex image generation extension.
 *
 * Registers `codex_generate_image`, a tool that uses Pi's existing
 * openai-codex ChatGPT/Codex auth to call the Codex Responses backend with the
 * native `image_generation` tool. The backend maps that tool to gpt-image-2.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { reportInstallTelemetry } from "../src/install-telemetry.js";

const PACKAGE_NAME = "pi-codex-image-gen";
const PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_SAVE_MODE = "global";
const OPENAI_BETA_HEADER = "responses=experimental";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_EDIT_IMAGES = 5;

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// --- #1: Retry helpers with exponential backoff + jitter ---

function isRetryableStatus(status: number, errorText: string): boolean {
	if ([429, 500, 502, 503, 504].includes(status)) return true;
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const milliseconds = Number(trimmed) * 1000;
		return Number.isFinite(milliseconds) ? Math.min(milliseconds, MAX_RETRY_DELAY_MS) : undefined;
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isFinite(dateMs) || dateMs <= nowMs) return undefined;
	return Math.min(dateMs - nowMs, MAX_RETRY_DELAY_MS);
}

export function retryDelayMs(
	attempt: number,
	retryAfter: string | null,
	random = Math.random,
	nowMs = Date.now(),
): number {
	const serverDelay = parseRetryAfter(retryAfter, nowMs);
	if (serverDelay !== undefined) {
		return Math.floor(Math.min(serverDelay * (1 + random() * 0.1), MAX_RETRY_DELAY_MS));
	}
	const exponential = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
	return Math.floor(exponential * (0.9 + random() * 0.2));
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Image generation was aborted."));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(finish, milliseconds);
		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
		function finish() {
			cleanup();
			resolve();
		}
		function abort() {
			cleanup();
			reject(new Error("Image generation was aborted."));
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

// --- Tool parameter schema ---

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "The image prompt. Be specific about subject, composition, style, text, and constraints." }),
	model: Type.Optional(
		Type.String({ description: `Codex model that should invoke image generation. Defaults to ${DEFAULT_MODEL}.` }),
	),
	outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS)),
	save: Type.Optional(StringEnum(SAVE_MODES)),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory to save the image when save=custom. Relative paths resolve under the current workspace.",
		}),
	),
	referencedImagePaths: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_EDIT_IMAGES,
			description: "Up to five local image paths to edit. Relative paths resolve under the current workspace.",
		}),
	),
	numLastImagesToInclude: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_EDIT_IMAGES,
			description: "Use the most recent one to five images from the current conversation as edit inputs.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

// --- Config types ---

interface ExtensionConfig {
	save?: SaveMode;
	saveDir?: string;
	model?: string;
}

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

interface GeneratedImage {
	id: string;
	status: string;
	result: string;
	revisedPrompt?: string;
}

interface ParsedCodexResponse {
	image?: GeneratedImage;
	text: string[];
	responseId?: string;
	usage?: unknown;
}

interface InputImage {
	data: string;
	mimeType: string;
}

// --- #11: Typed SSE event discriminated union ---

type CodexSseEvent =
	| { type: "error"; message?: string; code?: string }
	| { type: "response.failed"; response?: { error?: { message?: string } } }
	| { type: "response.created"; response?: { id?: string } }
	| { type: "response.output_text.delta"; delta?: string }
	| {
			type: "response.output_item.done";
			item?: {
				type?: string;
				id?: string | number;
				status?: string;
				result?: string;
				revised_prompt?: string;
			};
	  }
	| { type: "response.completed"; response?: { id?: string; usage?: unknown } };

// --- JWT helpers ---

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) {
		throw new Error("OpenAI Codex auth token is not a JWT. Run /login for openai-codex again.");
	}
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Failed to decode OpenAI Codex auth token: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractChatGptAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const authClaims = payload[JWT_CLAIM_PATH];
	if (!authClaims || typeof authClaims !== "object") {
		throw new Error("OpenAI Codex auth token does not contain ChatGPT auth claims. Run /login for openai-codex again.");
	}
	const accountId = (authClaims as Record<string, unknown>).chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("OpenAI Codex auth token does not contain chatgpt_account_id. Run /login for openai-codex again.");
	}
	return accountId;
}

// --- #10: try/catch readConfigFile replaces racy existsSync + readFileSync ---

function readConfigFile(path: string): ExtensionConfig {
	try {
		return JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): ExtensionConfig {
	const globalConfig = readConfigFile(join(agentDir, "extensions", "codex-image-gen.json"));
	if (!projectTrusted) return globalConfig;
	const projectConfig = readConfigFile(join(cwd, ".pi", "extensions", "codex-image-gen.json"));
	return { ...globalConfig, ...projectConfig };
}

// --- Path helpers ---

export function resolveUnderCwd(cwd: string, path: string, homeDir = homedir()): string {
	if (path === "~") return homeDir;
	if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function sanitizePathPart(value: string, fallback: string): string {
	const sanitized = value
		.split("")
		.map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : "_"))
		.join("")
		.replace(/_+$/g, "");
	return sanitized || fallback;
}

// --- #5: resolveSaveConfig accepts pre-loaded config (no double loadConfig) ---

function resolveSaveConfig(params: ToolParams, cwd: string, sessionId: string, config: ExtensionConfig): SaveConfig {
	const envMode = process.env.PI_CODEX_IMAGE_SAVE_MODE?.toLowerCase();
	const mode = (params.save || envMode || config.save || DEFAULT_SAVE_MODE) as SaveMode;
	const safeSessionId = sanitizePathPart(sessionId, "session");
	if (!SAVE_MODES.includes(mode)) {
		throw new Error(`Invalid save mode: ${mode}. Expected one of ${SAVE_MODES.join(", ")}.`);
	}
	if (mode === "project") {
		return { mode, outputDir: join(cwd, ".pi", "generated-images", safeSessionId) };
	}
	if (mode === "global") {
		return { mode, outputDir: join(getAgentDir(), "generated-images", safeSessionId) };
	}
	if (mode === "custom") {
		const configuredDir = params.saveDir || process.env.PI_CODEX_IMAGE_SAVE_DIR || config.saveDir;
		if (!configuredDir || !configuredDir.trim()) {
			throw new Error("save=custom requires saveDir or PI_CODEX_IMAGE_SAVE_DIR.");
		}
		return { mode, outputDir: join(resolveUnderCwd(cwd, configuredDir), safeSessionId) };
	}
	return { mode };
}

// --- Image save helpers ---

function extensionForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

function mimeForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
}

function imagePath(outputFormat: OutputFormat, outputDir: string, imageCallId: string): string {
	const filename = `${sanitizePathPart(imageCallId, "image_generation")}.${extensionForFormat(outputFormat)}`;
	return join(outputDir, filename);
}

export function decodeImageData(base64Data: string, outputFormat: OutputFormat): Buffer {
	const value = base64Data.trim();
	if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new Error("Codex returned invalid base64 image data.");
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== value) {
		throw new Error("Codex returned invalid base64 image data.");
	}
	const validSignature =
		(outputFormat === "png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
		(outputFormat === "jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
		(outputFormat === "webp" && bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
	if (!validSignature) throw new Error(`Codex returned image data that does not match ${outputFormat}.`);
	return bytes;
}

async function saveImage(
	bytes: Buffer,
	outputFormat: OutputFormat,
	outputDir: string,
	imageCallId: string,
): Promise<string> {
	const filePath = imagePath(outputFormat, outputDir, imageCallId);
	await withFileMutationQueue(filePath, async () => {
		await mkdir(outputDir, { recursive: true });
		await writeFile(filePath, bytes);
	});
	return filePath;
}

export function selectRecentImages(messages: unknown[], count: number): InputImage[] {
	const images: InputImage[] = [];
	for (let index = messages.length - 1; index >= 0 && images.length < count; index--) {
		const message = messages[index] as { content?: unknown };
		if (!Array.isArray(message?.content)) continue;
		for (let contentIndex = message.content.length - 1; contentIndex >= 0 && images.length < count; contentIndex--) {
			const block = message.content[contentIndex] as { type?: unknown; data?: unknown; mimeType?: unknown };
			if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
				images.push({ data: block.data, mimeType: block.mimeType });
			}
		}
	}
	return images.reverse();
}

function mimeFromBytes(bytes: Buffer, path: string): string {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	throw new Error(`Referenced image is unavailable or unsupported: ${path}`);
}

export async function resolveInputImages(
	params: ToolParams,
	cwd: string,
	messages: unknown[],
): Promise<InputImage[]> {
	const paths = params.referencedImagePaths ?? [];
	if (paths.length > 0 && params.numLastImagesToInclude !== undefined) {
		throw new Error("Provide only one of referencedImagePaths or numLastImagesToInclude.");
	}
	if (paths.length > MAX_EDIT_IMAGES) throw new Error(`referencedImagePaths accepts at most ${MAX_EDIT_IMAGES} paths.`);
	if (paths.length > 0) {
		return Promise.all(
			paths.map(async (path) => {
				const normalized = path.startsWith("@") ? path.slice(1) : path;
				const absolutePath = resolveUnderCwd(cwd, normalized);
				let bytes: Buffer;
				try {
					bytes = await readFile(absolutePath);
				} catch (error) {
					throw new Error(`Unable to read referenced image at ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
				}
				return { data: bytes.toString("base64"), mimeType: mimeFromBytes(bytes, absolutePath) };
			}),
		);
	}
	if (params.numLastImagesToInclude !== undefined) {
		const count = params.numLastImagesToInclude;
		if (!Number.isInteger(count) || count < 1 || count > MAX_EDIT_IMAGES) {
			throw new Error(`numLastImagesToInclude must be between 1 and ${MAX_EDIT_IMAGES}.`);
		}
		const images = selectRecentImages(messages, count);
		if (images.length !== count) {
			throw new Error(`Requested the last ${count} conversation images, but only ${images.length} were available.`);
		}
		return images;
	}
	return [];
}

// --- Request building ---
// #2: prompt_cache_key set to sessionId
// #7: parallel_tool_calls: false
// #14: include removed (not needed without reasoning)

export function buildRequestBody(
	params: ToolParams,
	model: string,
	outputFormat: OutputFormat,
	sessionId: string,
	inputImages: InputImage[] = [],
) {
	return {
		model,
		store: false,
		stream: true,
		prompt_cache_key: sessionId,
		instructions:
			"You are generating bitmap image assets. For this request, call the image_generation tool exactly once. Do not answer with only text unless image generation is unavailable.",
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: params.prompt },
					...inputImages.map((image) => ({
						type: "input_image",
						image_url: `data:${image.mimeType};base64,${image.data}`,
					})),
				],
			},
		],
		tools: [{ type: "image_generation", output_format: outputFormat }],
		tool_choice: "auto",
		parallel_tool_calls: false,
		text: { verbosity: "low" },
	};
}

// --- SSE parsing ---

function parseSseDataLines(chunk: string): string | undefined {
	const data = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	return data && data !== "[DONE]" ? data : undefined;
}

async function parseCodexSse(response: Response, signal?: AbortSignal): Promise<ParsedCodexResponse> {
	if (!response.body) throw new Error("Codex response did not include a stream body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const parsed: ParsedCodexResponse = { text: [] };

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Image generation was aborted.");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let separator = buffer.indexOf("\n\n");
			while (separator !== -1) {
				const chunk = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				const data = parseSseDataLines(chunk);
				if (data) handleCodexEvent(JSON.parse(data) as CodexSseEvent, parsed);
				separator = buffer.indexOf("\n\n");
			}
		}
		const remaining = parseSseDataLines(buffer);
		if (remaining) handleCodexEvent(JSON.parse(remaining) as CodexSseEvent, parsed);
	} finally {
		try {
			await reader.cancel();
		} catch {
			// ignored: stream may already be closed
		}
		reader.releaseLock();
	}

	return parsed;
}

// --- #11: Typed event handler via discriminated union ---

function handleCodexEvent(event: CodexSseEvent, parsed: ParsedCodexResponse): void {
	if (!event || typeof event !== "object") return;

	switch (event.type) {
		case "error": {
			const e = event as Extract<CodexSseEvent, { type: "error" }>;
			throw new Error(`Codex error: ${e.message || e.code || JSON.stringify(event)}`);
		}
		case "response.failed": {
			const e = event as Extract<CodexSseEvent, { type: "response.failed" }>;
			throw new Error(e.response?.error?.message || "Codex response failed.");
		}
		case "response.created": {
			const e = event as Extract<CodexSseEvent, { type: "response.created" }>;
			if (typeof e.response?.id === "string") {
				parsed.responseId = e.response.id;
			}
			break;
		}
		case "response.output_text.delta": {
			const e = event as Extract<CodexSseEvent, { type: "response.output_text.delta" }>;
			if (typeof e.delta === "string") {
				parsed.text.push(e.delta);
			}
			break;
		}
		case "response.output_item.done": {
			const e = event as Extract<CodexSseEvent, { type: "response.output_item.done" }>;
			const item = e.item;
			if (item?.type === "image_generation_call") {
				if (typeof item.result !== "string" || item.result.length === 0) {
					throw new Error("Codex image_generation_call did not contain image data.");
				}
				parsed.image = {
					id: String(item.id || "image_generation"),
					status: String(item.status || "completed"),
					result: item.result,
					revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
				};
			}
			break;
		}
		case "response.completed": {
			const e = event as Extract<CodexSseEvent, { type: "response.completed" }>;
			if (typeof e.response?.id === "string") parsed.responseId = e.response.id;
			if (e.response?.usage) parsed.usage = e.response.usage;
			break;
		}
	}
}

// --- #1: requestImage with retry + backoff + jitter ---

async function requestImage(
	params: ToolParams,
	token: string,
	accountId: string,
	model: string,
	outputFormat: OutputFormat,
	sessionId: string,
	inputImages: InputImage[],
	signal?: AbortSignal,
): Promise<ParsedCodexResponse> {
	const body = JSON.stringify(buildRequestBody(params, model, outputFormat, sessionId, inputImages));
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		originator: "pi",
		"OpenAI-Beta": OPENAI_BETA_HEADER,
		accept: "text/event-stream",
		"content-type": "application/json",
	};

	for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
		if (signal?.aborted) throw new Error("Image generation was aborted.");

		const response = await fetch(CODEX_RESPONSES_URL, {
			method: "POST",
			headers,
			body,
			signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			if (attempt <= MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
				const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
				await abortableDelay(delay, signal);
				continue;
			}
			throw new Error(`Codex image generation request failed (${response.status}): ${errorText}`);
		}

		return parseCodexSse(response, signal);
	}

	throw new Error("Codex image generation request failed after all retries.");
}

// --- Extension entry point ---

export default function codexImageGen(pi: ExtensionAPI) {
	reportInstallTelemetry();

	pi.registerTool({
		name: "codex_generate_image",
		label: "Codex Image",
		description:
			"Generate or edit an image with the OpenAI Codex ChatGPT backend built-in image_generation tool (gpt-image-2). Accepts up to five local or recent conversation images. Uses the existing openai-codex login; does not require OPENAI_API_KEY.",
		promptSnippet: "Generate or edit bitmap images via the OpenAI Codex ChatGPT backend gpt-image-2 image_generation tool.",
		promptGuidelines: [
			"Use codex_generate_image when the user asks to generate or edit a raster image with OpenAI/Codex image generation.",
			"Do not use codex_generate_image without a clear image-generation request, because it consumes the user's Codex image quota.",
		],
		parameters: TOOL_PARAMS,
		executionMode: "parallel", // #4: safe to run concurrently — no shared state, saves serialized per-path
		async execute(toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const outputFormat = params.outputFormat || "png";
			const projectTrusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
			const config = loadConfig(ctx.cwd, projectTrusted); // #5: load once, pass to resolveSaveConfig
			const requestedModel = params.model || config.model || DEFAULT_MODEL;
			const model = ctx.modelRegistry.find(PROVIDER, requestedModel)?.id || requestedModel; // #6: removed dead FALLBACK_MODEL
			const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (!token) {
				throw new Error(`Missing ${PROVIDER} credentials. Run /login and select ChatGPT Plus/Pro (Codex).`);
			}
			const accountId = extractChatGptAccountId(token);
			const sessionId = ctx.sessionManager.getSessionId();
			const messages: unknown[] = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message") messages.push(entry.message);
				if (entry.type === "custom_message") messages.push(entry);
			}
			const inputImages = await resolveInputImages(params, ctx.cwd, messages);

			onUpdate?.({
				content: [{ type: "text", text: `Requesting gpt-image-2 ${inputImages.length > 0 ? "edit" : "generation"} through ${PROVIDER}/${model}...` }],
				details: { provider: PROVIDER, model, outputFormat, inputImageCount: inputImages.length },
			});

			const parsed = await requestImage(params, token, accountId, model, outputFormat, sessionId, inputImages, signal);
			if (!parsed.image) {
				const text = parsed.text.join("").trim();
				throw new Error(text ? `Codex did not return an image. Response text: ${text}` : "Codex did not return an image.");
			}

			const imageBytes = decodeImageData(parsed.image.result, outputFormat);
			const saveConfig = resolveSaveConfig(params, ctx.cwd, sessionId, config);
			let savedPath: string | undefined;
			let attemptedPath: string | undefined;
			let saveWarning: string | undefined;
			if (saveConfig.mode !== "none" && saveConfig.outputDir) {
				attemptedPath = imagePath(outputFormat, saveConfig.outputDir, parsed.image.id || toolCallId);
				try {
					savedPath = await saveImage(imageBytes, outputFormat, saveConfig.outputDir, parsed.image.id || toolCallId);
					onUpdate?.({
						content: [{ type: "text", text: `Image saved to ${savedPath}.` }],
						details: { provider: PROVIDER, model, savedPath, byteCount: imageBytes.length },
					});
				} catch (error) {
					saveWarning = `Image generation succeeded, but the image could not be saved to disk: ${error instanceof Error ? error.message : String(error)}`;
				}
			}

			const summary = [
				`Generated image via ${PROVIDER}/${model} using backend gpt-image-2.`,
				`Status: ${parsed.image.status}.`,
				parsed.image.revisedPrompt ? `Revised prompt: ${parsed.image.revisedPrompt}` : undefined,
				savedPath ? `Saved image to: ${savedPath}` : "Image was not saved to disk.",
				saveWarning ? `Warning: ${saveWarning}` : undefined,
			]
				.filter(Boolean)
				.join(" ");

			return {
				content: [
					{ type: "text", text: summary },
					{ type: "image", data: parsed.image.result, mimeType: mimeForFormat(outputFormat) },
				],
				details: {
					provider: PROVIDER,
					model,
					backendImageModel: "gpt-image-2",
					outputFormat,
					saveMode: saveConfig.mode,
					savedPath,
					attemptedPath,
					saveWarning,
					inputImageCount: inputImages.length,
					responseId: parsed.responseId,
					imageGenerationId: parsed.image.id,
					revisedPrompt: parsed.image.revisedPrompt,
					usage: parsed.usage,
				},
			};
		},
	});
}
