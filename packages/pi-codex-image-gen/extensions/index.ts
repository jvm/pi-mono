/**
 * Project-local Codex image generation extension.
 *
 * Registers `codex_generate_image`, a tool that uses Pi's existing
 * openai-codex ChatGPT/Codex auth to call the Codex Responses backend with the
 * native `image_generation` tool. The backend maps that tool to gpt-image-2.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// --- #1: Retry helpers with exponential backoff + jitter ---

function isRetryableStatus(status: number, errorText: string): boolean {
	if ([429, 500, 502, 503, 504].includes(status)) return true;
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function backoffMs(attempt: number): number {
	const jitter = 0.9 + Math.random() * 0.2; // matches codex-rs jitter range
	return BASE_DELAY_MS * 2 ** (attempt - 1) * jitter;
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

async function saveImage(base64Data: string, outputFormat: OutputFormat, outputDir: string, imageCallId: string): Promise<string> {
	const filename = `${sanitizePathPart(imageCallId, "image_generation")}.${extensionForFormat(outputFormat)}`;
	const filePath = join(outputDir, filename);
	await withFileMutationQueue(filePath, async () => {
		await mkdir(outputDir, { recursive: true });
		await writeFile(filePath, Buffer.from(base64Data, "base64"));
	});
	return filePath;
}

// --- Request building ---
// #2: prompt_cache_key set to sessionId
// #7: parallel_tool_calls: false
// #14: include removed (not needed without reasoning)

function buildRequestBody(params: ToolParams, model: string, outputFormat: OutputFormat, sessionId: string) {
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
				content: [{ type: "input_text", text: params.prompt }],
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
	signal?: AbortSignal,
): Promise<ParsedCodexResponse> {
	const body = JSON.stringify(buildRequestBody(params, model, outputFormat, sessionId));
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
				const delay = backoffMs(attempt);
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
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
			"Generate an image with the OpenAI Codex ChatGPT backend built-in image_generation tool (gpt-image-2). Uses the existing openai-codex login; does not require OPENAI_API_KEY.",
		promptSnippet: "Generate bitmap images via the OpenAI Codex ChatGPT backend gpt-image-2 image_generation tool.",
		promptGuidelines: [
			"Use codex_generate_image when the user asks to generate a raster image, illustration, photo, sprite, icon draft, banner, or other bitmap asset with OpenAI/Codex image generation.",
			"Do not use codex_generate_image without a clear image-generation request, because it consumes the user's Codex image quota.",
		],
		parameters: TOOL_PARAMS,
		executionMode: "parallel", // #4: safe to run concurrently — no shared state, saves serialized per-path
		async execute(toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const outputFormat = params.outputFormat || "png";
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted()); // #5: load once, pass to resolveSaveConfig
			const requestedModel = params.model || config.model || DEFAULT_MODEL;
			const model = ctx.modelRegistry.find(PROVIDER, requestedModel)?.id || requestedModel; // #6: removed dead FALLBACK_MODEL
			const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (!token) {
				throw new Error(`Missing ${PROVIDER} credentials. Run /login and select ChatGPT Plus/Pro (Codex).`);
			}
			const accountId = extractChatGptAccountId(token);
			const sessionId = ctx.sessionManager.getSessionId();

			onUpdate?.({
				content: [{ type: "text", text: `Requesting gpt-image-2 generation through ${PROVIDER}/${model}...` }],
				details: { provider: PROVIDER, model, outputFormat },
			});

			const parsed = await requestImage(params, token, accountId, model, outputFormat, sessionId, signal);
			if (!parsed.image) {
				const text = parsed.text.join("").trim();
				throw new Error(text ? `Codex did not return an image. Response text: ${text}` : "Codex did not return an image.");
			}

			const saveConfig = resolveSaveConfig(params, ctx.cwd, sessionId, config);
			let savedPath: string | undefined;
			if (saveConfig.mode !== "none" && saveConfig.outputDir) {
				savedPath = await saveImage(parsed.image.result, outputFormat, saveConfig.outputDir, parsed.image.id || toolCallId);
				// #12: second onUpdate after save with path + byte count
				onUpdate?.({
					content: [{ type: "text", text: `Image saved to ${savedPath}.` }],
					details: {
						provider: PROVIDER,
						model,
						savedPath,
						byteCount: Buffer.byteLength(parsed.image.result, "base64"),
					},
				});
			}

			const summary = [
				`Generated image via ${PROVIDER}/${model} using backend gpt-image-2.`,
				`Status: ${parsed.image.status}.`,
				parsed.image.revisedPrompt ? `Revised prompt: ${parsed.image.revisedPrompt}` : undefined,
				savedPath ? `Saved image to: ${savedPath}` : "Image was not saved to disk.",
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
					responseId: parsed.responseId,
					imageGenerationId: parsed.image.id,
					revisedPrompt: parsed.image.revisedPrompt,
					usage: parsed.usage,
				},
			};
		},
	});
}
