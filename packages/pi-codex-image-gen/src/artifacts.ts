import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const ARTIFACT_ENTRY = "codex-image-artifact";

export interface ImageArtifact {
	path: string;
	mimeType: string;
	byteCount: number;
}

export interface ArtifactRecord {
	artifact: ImageArtifact;
	toolCallId: string;
}

// Read metadata, never image bytes, from the current branch. Session files can
// be edited externally, so do not blindly spread their data into tool results.
export function artifactRecord(value: unknown): ArtifactRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<ArtifactRecord>;
	const artifact = record.artifact;
	if (!artifact || typeof artifact.path !== "string" || artifact.path.length > 4096
		|| !isAbsolute(artifact.path) || /[\u0000-\u001f\u007f]/.test(artifact.path)
		|| !["image/png", "image/jpeg", "image/webp"].includes(artifact.mimeType)
		|| !Number.isInteger(artifact.byteCount) || artifact.byteCount <= 0 || artifact.byteCount > 32 * 1024 * 1024
		|| typeof record.toolCallId !== "string" || record.toolCallId.length > 256) return undefined;
	return {
		artifact: { path: artifact.path, mimeType: artifact.mimeType, byteCount: artifact.byteCount },
		toolCallId: record.toolCallId,
	};
}

/** Reserve private storage before spending quota. Keep completed files until
 * user/OS cleanup; reload, shutdown, and branch changes must not remove them. */
export async function reserveArtifact(extension: string, root = tmpdir()) {
	if (!["png", "jpg", "webp"].includes(extension)) throw new Error("Unsupported artifact format.");
	const absoluteRoot = resolve(root);
	if (absoluteRoot.length > 4000 || /[\u0000-\u001f\u007f]/.test(absoluteRoot)) {
		throw new Error("Image artifact storage path is unsupported. No generation request was made.");
	}
	const dir = await mkdtemp(join(absoluteRoot, "pi-codex-image-"));
	const path = join(dir, `original.${extension}`);
	let file: FileHandle | undefined;
	let committed = false;
	try {
		file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
	} catch {
		await rm(dir, { recursive: true, force: true });
		throw new Error("Image artifact storage is unavailable. No generation request was made.");
	}
	const handle = file;
	return {
		path,
		async commit(bytes: Buffer, mimeType: string): Promise<ImageArtifact> {
			await handle.writeFile(bytes);
			await handle.sync();
			const info = await handle.stat();
			const visible = await lstat(path);
			if (!visible.isFile() || info.ino !== visible.ino || info.dev !== visible.dev || visible.size !== bytes.length) {
				throw new Error("Image artifact is no longer available at its reserved path.");
			}
			committed = true;
			return { path, mimeType, byteCount: bytes.length };
		},
		async dispose() {
			try {
				await handle.close();
			} finally {
				if (!committed) await rm(dir, { recursive: true, force: true });
			}
		},
	};
}
