import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const ARTIFACT_ENTRY = "codex-image-artifact";
export const RESERVATION_ENTRY = "codex-image-artifact-reservation";

export interface ImageArtifact {
	path: string;
	mimeType: string;
	byteCount: number;
}

export interface ArtifactRecord {
	artifact: ImageArtifact;
	toolCallId: string;
}

export interface ArtifactReservation {
	path: string;
	mimeType: string;
	toolCallId: string;
}

export function artifactReservation(value: unknown): ArtifactReservation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as ArtifactReservation;
	// Reuse the path/MIME/call-ID validation without accepting a completed image.
	const validated = artifactRecord({
		artifact: { path: record.path, mimeType: record.mimeType, byteCount: 1 },
		toolCallId: record.toolCallId,
	});
	return validated ? { path: validated.artifact.path, mimeType: validated.artifact.mimeType, toolCallId: validated.toolCallId } : undefined;
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

/** Only a published, bounded manifest marks a reservation ready. The branch
 * reservation is written before generation, so late completions need not
 * mutate whichever branch/session the user is viewing after cancellation. */
export async function readArtifactManifest(reservation: ArtifactReservation): Promise<ArtifactRecord | undefined> {
	let file: FileHandle | undefined;
	try {
		file = await open(`${reservation.path}.json`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const info = await file.stat();
		const visible = await lstat(`${reservation.path}.json`);
		if (!info.isFile() || !visible.isFile() || info.ino !== visible.ino || info.dev !== visible.dev || info.size > 8192) return undefined;
		const buffer = Buffer.alloc(8193);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
			if (!bytesRead) break;
			total += bytesRead;
		}
		if (total > 8192) return undefined;
		const record = artifactRecord(JSON.parse(buffer.subarray(0, total).toString("utf8")));
		return record?.toolCallId === reservation.toolCallId && record.artifact.mimeType === reservation.mimeType ? record : undefined;
	} catch {
		return undefined;
	} finally {
		await file?.close().catch(() => undefined);
	}
}

export async function branchArtifacts(entries: readonly { type: string; customType?: string; data?: unknown }[]): Promise<ArtifactRecord[]> {
	const records = new Map<string, ArtifactRecord>();
	for (const entry of entries) {
		const reservation = entry.type === "custom" && entry.customType === RESERVATION_ENTRY ? artifactReservation(entry.data) : undefined;
		const record = reservation ? await readArtifactManifest(reservation)
			: entry.type === "custom" && entry.customType === ARTIFACT_ENTRY ? artifactRecord(entry.data) : undefined;
		if (record) {
			records.delete(record.artifact.path);
			records.set(record.artifact.path, record);
		}
	}
	return [...records.values()];
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
		async publish(record: ArtifactRecord) {
			const validated = artifactRecord(record);
			if (!validated) throw new Error("Invalid artifact recovery metadata.");
			const json = JSON.stringify(validated);
			if (Buffer.byteLength(json) > 8192) throw new Error("Artifact recovery metadata exceeds the size limit.");
			const manifest = await open(`${path}.json`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
			try {
				await manifest.writeFile(json);
				await manifest.sync();
			} finally {
				await manifest.close();
			}
			if (record.artifact.path !== path) await rm(path, { force: true });
			committed = true; // Retain fallback manifests too, never incomplete originals.
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
