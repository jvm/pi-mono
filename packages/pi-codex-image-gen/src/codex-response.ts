// The subscription Responses contract is private. Keep its parser and safety
// boundaries separate from Pi tool registration and file handling.
import { randomUUID } from "node:crypto";

export const REQUEST_TIMEOUT_MS = 5 * 60_000;
export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 4000;

export interface ReportedImage {
	model?: string;
	size?: string;
	quality?: string;
	background?: string;
	outputFormat?: string;
}

export interface ParsedCodexResponse {
	image?: {
		id: string;
		status: "completed";
		result: string;
		revisedPrompt?: string;
		reported: ReportedImage;
		generationId?: string;
	};
	text: string[];
	responseId?: string;
	requestId?: string;
	imagegenRequestId?: string;
	usage?: unknown;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function text(value: unknown, secrets: string[] = []): string {
	if (typeof value !== "string") return "";
	let result = value;
	for (const secret of secrets) {
		if (secret) result = result.split(secret).join("[redacted]");
	}
	// Also hide a JWT cut short by the text bound; exact-token matching alone
	// cannot redact a credential that arrives across the truncation boundary.
	return result.replace(/\beyJ[A-Za-z0-9_.-]*/g, "[redacted]")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, MAX_TEXT_CHARS);
}

function identifier(value: unknown, secrets: string[]): string | undefined {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
		&& !value.startsWith("eyJ")
		&& !secrets.some(secret => secret && value.includes(secret)) ? value : undefined;
}

export interface FailureDiagnostics {
	category: "authentication" | "quota" | "moderation" | "unsupported-feature" | "invalid-request" | "backend";
	status?: number;
	code?: string;
	requestId?: string;
	imagegenRequestId?: string;
	responseId?: string;
}

export class CodexRequestError extends Error {
	constructor(message: string, readonly diagnostics: FailureDiagnostics) {
		const ids = [
			diagnostics.code ? `Code: ${diagnostics.code}.` : "",
			diagnostics.requestId ? `Request ID: ${diagnostics.requestId}.` : "",
			diagnostics.imagegenRequestId ? `Image request ID: ${diagnostics.imagegenRequestId}.` : "",
			diagnostics.responseId ? `Response ID: ${diagnostics.responseId}.` : "",
		].filter(Boolean).join(" ");
		super(`${message}${ids ? ` ${ids}` : ""}`);
		this.name = "CodexRequestError";
	}
}

function requestIds(response: Response, secrets: string[]) {
	return {
		requestId: identifier(response.headers.get("x-request-id"), secrets),
		imagegenRequestId: identifier(response.headers.get("x-codex-imagegen-request-id"), secrets),
	};
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export async function withRequestDeadline<T>(
	signal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Image generation was aborted."));
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error(
		"Image generation timed out after 5 minutes. The backend may still finish; no automatic retry was made.",
	)), REQUEST_TIMEOUT_MS);
	try {
		controller.signal.throwIfAborted();
		return await run(controller.signal);
	} catch (error) {
		if (controller.signal.aborted) throw controller.signal.reason;
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

async function* chunks(response: Response, limit: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
	if (!response.body) throw new Error("Codex response did not include a stream body.");
	const reader = response.body.getReader();
	let bytes = 0;
	try {
		const declared = Number(response.headers.get("content-length"));
		if (declared > limit) throw new Error("Codex response exceeded the size limit.");
		while (true) {
			signal.throwIfAborted();
			let part: ReadableStreamReadResult<Uint8Array>;
			try {
				part = await abortable(reader.read(), signal);
			} catch {
				signal.throwIfAborted();
				throw new Error("Codex response stream was interrupted. The backend may still finish; no automatic retry was made.");
			}
			const { done, value } = part;
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) throw new Error("Codex response exceeded the size limit.");
			yield value;
		}
	} finally {
		// Do not let a stalled stream cancellation defeat the request deadline.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

const QUOTA_CODES = new Set([
	"insufficient_quota", "quota_exceeded", "usage_limit_reached", "usage_limit_exceeded",
	"billing_hard_limit_reached", "billing_not_active", "organization_usage_limit_exceeded",
	"workspace_member_usage_limit_reached",
]);

function isQuota(error: Record<string, unknown>): boolean {
	return [error.code, error.type].some(value => typeof value === "string" && QUOTA_CODES.has(value));
}

function classifyError(value: unknown, status?: number): Pick<FailureDiagnostics, "category"> & { message: string } {
	const error = object(value);
	const { code, type } = error;
	if (status === 401 || status === 403) return { category: "authentication", message: status === 401
		? "Image login was rejected. Run /login codex-images again."
		: "Codex access was denied. This can be a connection or account restriction; it does not identify the image model." };
	if (isQuota({ code, type })) {
		return { category: "quota", message: "Codex subscription quota is unavailable or exhausted. Check your plan or wait for its reset." };
	}
	if (code === "moderation_blocked") {
		return { category: "moderation", message: "Codex could not generate this image. Review the prompt and input images before trying again." };
	}
	if (error.detail === "GIF output is not enabled for this request."
		|| error.message === "GIF output is not enabled for this request."
		|| ["unsupported_parameter", "unsupported_value", "invalid_input_fidelity_model", "unsupported_model", "invalid_complexity"].includes(String(code))
		|| ["Complexity 'low' is not supported for this image model.", "Complexity 'medium' is not supported for this image model."].includes(String(error.message))) {
		return { category: "unsupported-feature", message: "Codex has not enabled or does not support this image feature for this request. No alternate transport or API fallback was used." };
	}
	if (type === "image_generation_user_error" || status === 400 || status === 422) {
		return { category: "invalid-request", message: "Codex could not generate this image. Review the prompt and input images before trying again." };
	}
	return { category: "backend", message: "Codex could not complete the image request." };
}

export async function httpFailure(response: Response, signal: AbortSignal, secrets: string[] = []): Promise<{ message: string; retry: boolean; diagnostics: FailureDiagnostics }> {
	if (response.headers.get("cf-mitigated") === "challenge") {
		void response.body?.cancel().catch(() => undefined);
		return { message: "Codex connection was challenged by Cloudflare. This does not establish model or subscription availability.", retry: false,
			diagnostics: { category: "backend", status: response.status, ...requestIds(response, secrets) } };
	}
	let body = "";
	try {
		const decoder = new TextDecoder();
		for await (const chunk of chunks(response, MAX_ERROR_BYTES, signal)) body += decoder.decode(chunk, { stream: true });
		body += decoder.decode();
	} catch {
		signal.throwIfAborted();
		// A large or unreadable error body is deliberately not exposed.
	}
	let error: Record<string, unknown> = {};
	try {
		const parsed = object(JSON.parse(body));
		error = parsed.error ? object(parsed.error) : parsed;
	} catch { /* HTML and other non-JSON error bodies are not diagnostics. */ }
	const classified = classifyError(error, response.status);
	const terminal = classified.category === "unsupported-feature" || isQuota(error)
		|| error.code === "moderation_blocked" || error.type === "image_generation_user_error";
	const diagnostics: FailureDiagnostics = {
		category: classified.category, status: response.status,
		code: identifier(error.code, secrets), ...requestIds(response, secrets),
	};
	return {
		message: `Codex image request failed (HTTP ${response.status}). ${classified.message}`,
		retry: !terminal && [429, 500, 502, 503, 504].includes(response.status),
		diagnostics,
	};
}

function reportedImage(item: Record<string, unknown>, secrets: string[]): ReportedImage {
	const reported: ReportedImage = {};
	const model = item.model;
	if (typeof model === "string" && /^gpt-image-[a-z0-9.-]{1,80}$/.test(model)
		&& !secrets.some(secret => secret && model.includes(secret))) reported.model = model;
	if (typeof item.size === "string" && /^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(item.size)) reported.size = item.size;
	if (typeof item.quality === "string" && ["low", "medium", "high", "xhigh", "max", "auto"].includes(item.quality)) reported.quality = item.quality;
	if (typeof item.background === "string" && ["transparent", "opaque", "auto"].includes(item.background)) reported.background = item.background;
	if (typeof item.output_format === "string" && ["png", "jpeg", "webp"].includes(item.output_format)) reported.outputFormat = item.output_format;
	return reported;
}

export async function parseCodexSse(
	response: Response,
	signal: AbortSignal,
	secrets: string[],
	onProgress?: (stage: string) => void,
): Promise<ParsedCodexResponse> {
	const parsed: ParsedCodexResponse = { text: [], ...requestIds(response, secrets) };
	let completed = false;
	let textChars = 0;
	let lastStage: string | undefined;
	const image = (value: unknown) => {
		const item = object(value);
		if (item.type !== "image_generation_call") return;
		if (parsed.image) throw new Error("Codex returned more than one image. No automatic retry was made.");
		if (item.status !== "completed") throw new Error("Codex image generation did not complete.");
		if (typeof item.result !== "string" || !item.result) throw new Error("Codex image_generation_call did not contain image data.");
		if (item.result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Codex image exceeded the 32 MiB size limit.");
		parsed.image = {
			id: identifier(item.id, secrets) ?? "image_generation",
			status: "completed",
			result: item.result,
			revisedPrompt: text(item.revised_prompt, secrets) || undefined,
			reported: reportedImage(item, secrets),
		};
	};
	const handle = (frame: string) => {
		const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
		if (!data || data === "[DONE]") return;
		let event: Record<string, unknown>;
		try { event = object(JSON.parse(data)); }
		catch { throw new Error("Codex returned an invalid stream event. No automatic retry was made."); }
		switch (event.type) {
			case "error":
			case "response.failed":
				{
					const error = object(object(event.response).error ?? event.error ?? event);
					const classified = classifyError(error);
					throw new CodexRequestError(classified.message, {
						category: classified.category, code: identifier(error.code, secrets),
						...requestIds(response, secrets), responseId: parsed.responseId,
					});
				}
			case "response.incomplete":
				throw new Error("Codex response was incomplete. No automatic retry was made.");
			case "response.created":
				parsed.responseId = identifier(object(event.response).id, secrets);
				break;
			case "response.output_text.delta":
				if (typeof event.delta === "string" && textChars < MAX_TEXT_CHARS) {
					const delta = event.delta.slice(0, MAX_TEXT_CHARS - textChars);
					parsed.text.push(delta);
					textChars += delta.length;
				}
				break;
			case "response.output_item.done":
				image(event.item);
				break;
			case "response.completed": {
				const final = object(event.response);
				parsed.responseId = identifier(final.id, secrets) ?? parsed.responseId;
				// Usage contains numeric counters only; never persist arbitrary response objects.
				const usage = object(final.usage);
				const counters: Record<string, unknown> = Object.fromEntries(
					["input_tokens", "output_tokens", "total_tokens"].flatMap(key =>
						typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0
							? [[key, usage[key]]] : []),
				);
				for (const [key, fields] of [
					["input_tokens_details", ["cached_tokens"]],
					["output_tokens_details", ["reasoning_tokens"]],
				] as const) {
					const values = object(usage[key]);
					const details = Object.fromEntries(fields.flatMap(field =>
						typeof values[field] === "number" && Number.isFinite(values[field]) && values[field] >= 0
							? [[field, values[field]]] : []));
					if (Object.keys(details).length) counters[key] = details;
				}
				if (Object.keys(counters).length) parsed.usage = counters;
				if (!parsed.image && Array.isArray(final.output)) final.output.forEach(image);
				completed = true;
				break;
			}
			case "response.image_generation_call.in_progress":
			case "response.image_generation_call.generating":
			case "response.image_generation_call.completed":
				if (event.type !== lastStage) {
					lastStage = event.type;
					onProgress?.(event.type.split(".").at(-1)!);
				}
				break;
		}
	};
	const decoder = new TextDecoder();
	let buffer = "";
	let scanFrom = 0;
	for await (const chunk of chunks(response, MAX_RESPONSE_BYTES, signal)) {
		buffer += decoder.decode(chunk, { stream: true });
		const separator = /\r?\n\r?\n/g;
		separator.lastIndex = scanFrom;
		let match: RegExpExecArray | null;
		while ((match = separator.exec(buffer))) {
			handle(buffer.slice(0, match.index));
			buffer = buffer.slice(match.index + match[0].length);
			if (completed) break;
			separator.lastIndex = 0;
		}
		if (completed) break;
		scanFrom = Math.max(0, buffer.length - 3);
	}
	if (!completed) {
		buffer += decoder.decode();
		if (buffer.trim()) handle(buffer);
	}
	if (!completed) throw new Error("Codex stream ended before completion. The backend may still finish; no automatic retry was made.");
	parsed.text = [text(parsed.text.join(""), secrets)];
	return parsed;
}

function imageUsage(value: unknown): Record<string, unknown> | undefined {
	const usage = object(value);
	const counters = (record: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields.flatMap(key =>
		typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0 ? [[key, record[key]]] : []));
	const result: Record<string, unknown> = counters(usage, ["input_tokens", "output_tokens", "total_tokens"]);
	for (const key of ["input_tokens_details", "output_tokens_details"]) {
		const details = counters(object(usage[key]), ["image_tokens", "text_tokens", "cached_tokens", "reasoning_tokens"]);
		if (Object.keys(details).length) result[key] = details;
	}
	return Object.keys(result).length ? result : undefined;
}

/** Bounded JSON from the private Codex Images routes, not public API billing. */
export async function parseCodexImages(
	response: Response, signal: AbortSignal, secrets: string[],
): Promise<ParsedCodexResponse> {
	const decoder = new TextDecoder();
	let body = "";
	for await (const chunk of chunks(response, MAX_RESPONSE_BYTES, signal)) body += decoder.decode(chunk, { stream: true });
	body += decoder.decode();
	let parsed: Record<string, unknown>;
	try { parsed = object(JSON.parse(body)); }
	catch { throw new Error("Codex returned invalid image JSON. No automatic retry was made."); }
	if (parsed.error || parsed.detail) {
		const error = object(parsed.error ?? parsed);
		const classified = classifyError(error);
		throw new CodexRequestError(classified.message, { category: classified.category,
			code: identifier(error.code, secrets), ...requestIds(response, secrets) });
	}
	if (!Array.isArray(parsed.data) || parsed.data.length !== 1) throw new Error("Codex must return exactly one image. No automatic retry was made.");
	const item = object(parsed.data[0]);
	if (typeof item.b64_json !== "string" || !item.b64_json) throw new Error("Codex did not return image data.");
	if (item.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Codex image exceeded the 32 MiB size limit.");
	const generationId = identifier(item.generation_id, secrets);
	return {
		text: [], ...requestIds(response, secrets), usage: imageUsage(parsed.usage),
		image: {
			id: generationId ?? randomUUID(), generationId, status: "completed",
			result: item.b64_json, reported: reportedImage(parsed, secrets),
		},
	};
}
