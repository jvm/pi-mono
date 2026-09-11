/**
 * Project-local Codex image generation extension.
 *
 * Registers `codex_generate_image`, a tool that uses Pi's existing
 * openai-codex ChatGPT/Codex auth to call the Codex Responses backend with the
 * native `image_generation` tool. The backend selects the image model.
 */

import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { abortable, httpFailure, MAX_IMAGE_BYTES, parseCodexSse, withRequestDeadline, type ParsedCodexResponse } from "../src/codex-response.js";

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
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PROMPT_CHARS = 32_000;

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// --- #1: Retry helpers with exponential backoff + jitter ---

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
	prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_CHARS, description: "The image prompt. Be specific about subject, composition, style, text, and constraints." }),
	model: Type.Optional(
		Type.String({ minLength: 1, maxLength: 200, description: `Codex routing model, not an image model selector. Defaults to ${DEFAULT_MODEL}.` }),
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

interface InputImage {
	data: string;
	mimeType: string;
}

// --- JWT helpers ---

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) {
		throw new Error("OpenAI Codex auth token is not a JWT. Run /login for openai-codex again.");
	}
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		throw new Error("Failed to decode OpenAI Codex auth token. Run /login for openai-codex again.");
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
	const projectConfig = readConfigFile(join(cwd, CONFIG_DIR_NAME, "extensions", "codex-image-gen.json"));
	return { ...globalConfig, ...projectConfig };
}

// --- Path helpers ---

export function resolveUnderCwd(cwd: string, path: string, homeDir = homedir()): string {
	if (path === "~") return homeDir;
	if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function sanitizePathPart(value: string, fallback: string): string {
	const sanitized = value.slice(0, 128)
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
		return { mode, outputDir: join(cwd, CONFIG_DIR_NAME, "generated-images", safeSessionId) };
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
	if (base64Data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Codex image exceeded the 32 MiB size limit.");
	const value = base64Data.trim();
	if (!value || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
		throw new Error("Codex returned invalid base64 image data.");
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== value) {
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
		await mkdir(outputDir, { recursive: true, mode: 0o700 });
		await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
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

async function readInputImage(path: string): Promise<Buffer> {
	// O_NONBLOCK prevents named pipes from blocking before the regular-file check.
	const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("Referenced images must be regular files.");
		if (info.size > MAX_INPUT_IMAGE_BYTES) throw new Error("Referenced image exceeds 20 MiB.");
		const blocks: Buffer[] = [];
		let total = 0;
		while (true) {
			const block = Buffer.alloc(Math.min(64 * 1024, MAX_INPUT_IMAGE_BYTES + 1 - total));
			const { bytesRead } = await file.read(block, 0, block.length, null);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > MAX_INPUT_IMAGE_BYTES) throw new Error("Referenced image exceeds 20 MiB.");
			blocks.push(block.subarray(0, bytesRead));
		}
		return Buffer.concat(blocks, total);
	} finally {
		await file.close();
	}
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
		const images: InputImage[] = [];
		let total = 0;
		for (const path of paths) {
			const normalized = path.startsWith("@") ? path.slice(1) : path;
			const absolutePath = resolveUnderCwd(cwd, normalized);
			let bytes: Buffer;
			try {
				bytes = await readInputImage(absolutePath);
			} catch (error) {
				throw new Error(`Unable to read referenced image at ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
			total += bytes.length;
			if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("Referenced images exceed 50 MiB in total.");
			images.push({ data: bytes.toString("base64"), mimeType: mimeFromBytes(bytes, absolutePath) });
		}
		return images;
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
		let total = 0;
		for (const image of images) {
			if (image.data.length > Math.ceil(MAX_INPUT_IMAGE_BYTES / 3) * 4) throw new Error("Conversation image exceeds 20 MiB.");
			const format = OUTPUT_FORMATS.find(format => mimeForFormat(format) === image.mimeType);
			if (!format) throw new Error("Conversation image has an unsupported format.");
			total += decodeImageData(image.data, format).length;
			if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("Conversation images exceed 50 MiB in total.");
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
	onProgress?: (stage: string) => void,
): Promise<ParsedCodexResponse> {
	const body = JSON.stringify(buildRequestBody(params, model, outputFormat, sessionId, inputImages));
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		originator: "pi",
		"User-Agent": PACKAGE_NAME,
		"OpenAI-Beta": OPENAI_BETA_HEADER,
		accept: "text/event-stream",
		"content-type": "application/json",
	};

	return withRequestDeadline(signal, async (signal) => {
		for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
			signal.throwIfAborted();
			let response: Response;
			try {
				response = await abortable(fetch(CODEX_RESPONSES_URL, {
					method: "POST", headers, body, signal, redirect: "error",
				}), signal);
			} catch {
				signal.throwIfAborted();
				throw new Error("Codex connection failed. No automatic retry was made; check connectivity before trying again.");
			}

			if (!response.ok) {
				const failure = await httpFailure(response, signal);
				if (attempt <= MAX_RETRIES && failure.retry) {
					const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
					await abortableDelay(delay, signal);
					continue;
				}
				throw new Error(failure.message);
			}

			return parseCodexSse(response, signal, [token, accountId], onProgress);
		}
		throw new Error("Codex image generation request failed after all retries.");
	});
}

// --- Extension entry point ---

export default function codexImageGen(pi: ExtensionAPI) {
	reportInstallTelemetry();

	pi.registerTool({
		name: "codex_generate_image",
		label: "Codex Image",
		description:
			"Generate or edit an image with the OpenAI Codex ChatGPT backend built-in image_generation tool. The backend selects the image model. Accepts up to five local or recent conversation images (20 MiB each, 50 MiB total). Uses the existing openai-codex login; does not require OPENAI_API_KEY. Network deadline: 5 minutes; output image limit: 32 MiB; backend text is limited to 4,000 characters.",
		promptSnippet: "Generate or edit bitmap images via the OpenAI Codex ChatGPT backend image_generation tool.",
		promptGuidelines: [
			"Use codex_generate_image when the user asks to generate or edit a raster image with OpenAI/Codex image generation.",
			"Do not use codex_generate_image without a clear image-generation request, because it consumes the user's Codex image quota.",
		],
		parameters: TOOL_PARAMS,
		executionMode: "parallel", // #4: safe to run concurrently — no shared state, saves serialized per-path
		async execute(toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			if (typeof params.prompt !== "string" || !params.prompt.trim() || params.prompt.length > MAX_PROMPT_CHARS) {
				throw new Error("Image prompt must contain 1 to 32,000 characters.");
			}
			const outputFormat = params.outputFormat || "png";
			if (!OUTPUT_FORMATS.includes(outputFormat)) throw new Error("Unsupported image output format.");
			const projectTrusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
			const config = loadConfig(ctx.cwd, projectTrusted); // #5: load once, pass to resolveSaveConfig
			const requestedModel = params.model || config.model || DEFAULT_MODEL;
			if (typeof requestedModel !== "string" || !requestedModel.trim() || requestedModel.length > 200) {
				throw new Error("Codex routing model must contain 1 to 200 characters.");
			}
			if (requestedModel.startsWith("gpt-image-")) {
				throw new Error("The model parameter selects a Codex routing model, not an image model. Subscription image-model selection is not verified.");
			}
			const model = ctx.modelRegistry.find(PROVIDER, requestedModel)?.id || requestedModel; // #6: removed dead FALLBACK_MODEL
			const sessionId = ctx.sessionManager.getSessionId();
			const saveConfig = resolveSaveConfig(params, ctx.cwd, sessionId, config);
			const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (!token) {
				throw new Error(`Missing ${PROVIDER} credentials. Run /login and select ChatGPT Plus/Pro (Codex).`);
			}
			const accountId = extractChatGptAccountId(token);
			const messages: unknown[] = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message") messages.push(entry.message);
				if (entry.type === "custom_message") messages.push(entry);
			}
			const inputImages = await resolveInputImages(params, ctx.cwd, messages);

			onUpdate?.({
				content: [{ type: "text", text: `Requesting image ${inputImages.length > 0 ? "edit" : "generation"} through ${PROVIDER}/${model}...` }],
				details: { provider: PROVIDER, model, outputFormat, inputImageCount: inputImages.length },
			});

			const started = Date.now();
			const parsed = await requestImage(params, token, accountId, model, outputFormat, sessionId, inputImages, signal, (stage) => {
				onUpdate?.({
					content: [{ type: "text", text: `Codex image stage: ${stage}.` }],
					details: { provider: PROVIDER, model, stage },
				});
			});
			if (!parsed.image) {
				const text = parsed.text.join("").trim();
				throw new Error(text ? `Codex did not return an image. Response text: ${text}` : "Codex did not return an image.");
			}

			const imageBytes = decodeImageData(parsed.image.result, outputFormat);
			const reportedImage = parsed.image.reported;
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
				`Generated image via ${PROVIDER}/${model} using the backend-selected image model.`,
				`Status: ${parsed.image.status}.`,
				reportedImage.size ? `Backend-reported size: ${reportedImage.size}.` : undefined,
				reportedImage.quality ? `Backend-reported quality: ${reportedImage.quality}.` : undefined,
				reportedImage.background ? `Backend-reported background: ${reportedImage.background}.` : undefined,
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
					backendImageModel: reportedImage.model ?? "unknown",
					reportedImage,
					transport: "codex-responses",
					generationDurationMs: Date.now() - started,
					byteCount: imageBytes.length,
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
