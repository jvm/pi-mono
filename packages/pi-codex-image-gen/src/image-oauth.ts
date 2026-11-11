import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthAuth, OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { abortable } from "./codex-response.js";

export const IMAGE_AUTH_PROVIDER = "codex-images";
// Public OAuth client used by the image-capable ChatGPT/Codex flow.
// This is a client identifier, not a secret. No Codex app or Pi legacy helper is used.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const AUTH_CLAIM = "https://api.openai.com/auth";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const LOGIN_HINT = `Run /login ${IMAGE_AUTH_PROVIDER} again.`;

class ImageOAuthDeniedError extends Error {
	constructor() { super(`Image OAuth authorization was denied. ${LOGIN_HINT}`); }
}

export function extractImageAccountId(token: string): string {
	try {
		if (typeof token !== "string" || token.length > MAX_TOKEN_RESPONSE_BYTES
			|| /[^a-zA-Z0-9_.-]/.test(token)) throw new Error();
		const parts = token.split(".");
		if (parts.length !== 3 || parts.some(part => !part)) throw new Error();
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const accountId = payload?.[AUTH_CLAIM]?.chatgpt_account_id;
		if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 128
			|| /[^a-zA-Z0-9_-]/.test(accountId)) throw new Error();
		// Routing hint only: OpenAI, not this client, authenticates the JWT.
		return accountId;
	} catch {
		throw new Error(`Image OAuth token has no valid ChatGPT account ID. ${LOGIN_HINT}`);
	}
}

export function parseImageOAuthCallback(input: string, state: string): string {
	try {
		if (input.length > 8192) throw new Error();
		const url = new URL(input.trim());
		const expected = new URL(REDIRECT_URI);
		if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash
			|| url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) throw new Error();
		if (url.searchParams.has("error")) throw new ImageOAuthDeniedError();
		const codes = url.searchParams.getAll("code");
		if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) throw new Error();
		return codes[0];
	} catch (error) {
		if (error instanceof ImageOAuthDeniedError) throw error;
		throw new Error("Invalid image OAuth callback. Paste the full redirect URL from this login attempt.");
	}
}

/** Test seam only: the redirect URI always names port 1455, as registered for this client. */
export interface ImageOAuthOptions {
	/** Port the loopback listener binds; 0 picks a free port. Defaults to 1455. */
	callbackPort?: number;
	/** Reports the bound listener port. */
	onCallbackListening?: (port: number) => void;
}

async function startCallback(state: string, options: ImageOAuthOptions): Promise<{ server: Server; code: Promise<string> }> {
	let settle!: (code: string) => void;
	let reject!: (error: Error) => void;
	const code = new Promise<string>((resolve, rejectCode) => { settle = resolve; reject = rejectCode; });
	void code.catch(() => undefined);
	let consumed = false;
	const server = createServer((request, response) => {
		if (request.method !== "GET" || consumed) {
			response.writeHead(400).end("Invalid OAuth callback.");
			return;
		}
		try {
			const value = parseImageOAuthCallback(new URL(request.url ?? "/", REDIRECT_URI).href, state);
			consumed = true;
			response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
				.end("Image login completed. You can close this window.");
			settle(value);
		} catch (error) {
			// Do not reflect a code, state, or arbitrary query text into the page.
			response.writeHead(400).end("Invalid OAuth callback. Return to Pi and retry.");
			if (error instanceof ImageOAuthDeniedError) {
				consumed = true;
				reject(error);
			}
		}
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 15_000;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.callbackPort ?? CALLBACK_PORT, "127.0.0.1", () => {
				server.removeListener("error", reject);
				const address = server.address();
				if (address && typeof address === "object") options.onCallbackListening?.(address.port);
				resolve();
			});
		});
		server.on("error", () => reject(new Error(`Image OAuth callback failed. ${LOGIN_HINT}`)));
		return { server, code };
	} catch {
		server.close();
		throw new Error("Image OAuth callback listener is unavailable.");
	}
}

async function requestTokens(body: URLSearchParams, signal: AbortSignal): Promise<OAuthCredential> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]);
	try {
		const response = await abortable(fetch(TOKEN_URL, {
			method: "POST", redirect: "error", signal: deadline,
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body,
		}), deadline);
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error();
		}
		if (Number(response.headers.get("content-length")) > MAX_TOKEN_RESPONSE_BYTES || !response.body) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error();
		}
		const reader = response.body.getReader();
		const blocks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { done, value } = await abortable(reader.read(), deadline);
				if (done) break;
				length += value.byteLength;
				if (length > MAX_TOKEN_RESPONSE_BYTES) throw new Error();
				blocks.push(value);
			}
		} finally {
			void reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		const data = JSON.parse(Buffer.concat(blocks).toString("utf8"));
		if (typeof data?.access_token !== "string" || !data.access_token
			|| typeof data.refresh_token !== "string" || !data.refresh_token
			|| typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error();
		const expires = Date.now() + data.expires_in * 1000;
		if (!Number.isSafeInteger(expires)) throw new Error();
		const accountId = extractImageAccountId(data.access_token);
		return { type: "oauth", access: data.access_token, refresh: data.refresh_token, expires, accountId };
	} catch {
		// Never expose token responses, refresh tokens, codes, or fetch exceptions.
		if (signal.aborted) throw new Error("Image OAuth was cancelled.");
		throw new Error(`Image OAuth token exchange failed. ${LOGIN_HINT}`);
	}
}

async function login(interaction: ProviderAuthInteraction, options: ImageOAuthOptions = {}): Promise<OAuthCredential> {
	const deadline = AbortSignal.any([interaction.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]);
	const manualAbort = new AbortController();
	let callback: Awaited<ReturnType<typeof startCallback>> | undefined;
	try {
		deadline.throwIfAborted();
		const state = randomBytes(32).toString("base64url");
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		try {
			callback = await startCallback(state, options);
		} catch {
			interaction.notify({ type: "info", message: "The local callback port is unavailable. Paste the full redirect URL to finish image login." });
		}
		const url = new URL(AUTHORIZE_URL);
		url.search = new URLSearchParams({
			response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
			scope: "openid profile email offline_access", state,
			code_challenge: challenge, code_challenge_method: "S256",
			id_token_add_organizations: "true", codex_cli_simplified_flow: "true",
			originator: "pi",
		}).toString();
		interaction.notify({
			type: "auth_url", url: url.href,
			instructions: "Sign in with ChatGPT for image generation. This is separate from Pi's OpenAI chat login."
				+ (callback ? "" : " The local callback port is unavailable. Paste the full redirect URL into Pi to finish login."),
		});
		const manual = interaction.prompt({
			type: "manual_code",
			message: callback ? "Complete image login in your browser, or paste the full redirect URL:"
				: "The local callback port is unavailable. Paste the full redirect URL:",
			placeholder: REDIRECT_URI, signal: AbortSignal.any([deadline, manualAbort.signal]),
		}).then(input => parseImageOAuthCallback(input, state));
		const code = await abortable(callback ? Promise.race([callback.code, manual]) : manual, deadline);
		manualAbort.abort();
		return await requestTokens(new URLSearchParams({
			grant_type: "authorization_code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
			code, code_verifier: verifier,
		}), deadline);
	} catch (error) {
		if (deadline.aborted) throw new Error("Image OAuth login was cancelled or timed out.");
		throw error;
	} finally {
		manualAbort.abort();
		callback?.server.close();
		callback?.server.closeAllConnections();
	}
}

export function createImageOAuth(options: ImageOAuthOptions = {}): OAuthAuth {
	return {
		name: "Codex Images (ChatGPT subscription)",
		isSubscription: true,
		loginLabel: "Sign in with ChatGPT for images",
		login: interaction => login(interaction, options),
		async refresh(credential, signal) {
			if (typeof credential.refresh !== "string" || !credential.refresh || credential.refresh.length > MAX_TOKEN_RESPONSE_BYTES) {
				throw new Error(`Missing image OAuth refresh token. ${LOGIN_HINT}`);
			}
			return requestTokens(new URLSearchParams({
				grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: credential.refresh,
			}), signal);
		},
		async toAuth(credential) {
			extractImageAccountId(credential.access);
			return { apiKey: credential.access };
		},
	};
}

export const imageOAuth: OAuthAuth = createImageOAuth();

// Authentication-only provider: no chat models or model-picker entries.
export const imageAuthProvider: Provider = {
	id: IMAGE_AUTH_PROVIDER,
	name: imageOAuth.name,
	auth: { oauth: imageOAuth },
	getModels: () => [],
	stream() { throw new Error("Codex Images is an authentication-only provider. Use codex_generate_image."); },
	streamSimple() { throw new Error("Codex Images is an authentication-only provider. Use codex_generate_image."); },
};
