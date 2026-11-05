import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { getImageDimensions } from "@earendil-works/pi-tui";

export type OutputFormat = "png" | "jpeg" | "webp";
export const MAX_INSPECTION_PIXELS = 16_777_216;
export const INSPECTION_TIMEOUT_MS = 3000;

export interface MeasuredImage {
  outputFormat: OutputFormat;
  width: number;
  height: number;
  hasTransparency: boolean;
  alphaMin: number;
  alphaMax: number;
}

export function detectOutputFormat(bytes: Buffer): OutputFormat {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw new Error("Codex returned an unsupported image format. No automatic retry was made.");
}

// Keep untrusted decoding off the agent thread. Do not transport decoded pixels
// back into Pi or reuse decoder memory between calls. The worker always exits.
const INSPECT_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
let image;
try {
  const { PhotonImage } = require(workerData.modulePath);
  image = PhotonImage.new_from_byteslice(workerData.bytes);
  const width = image.get_width(), height = image.get_height();
  if (width !== workerData.width || height !== workerData.height) throw new Error("Dimensions differ");
  const pixels = image.get_raw_pixels();
  if (pixels.length !== width * height * 4) throw new Error("Invalid decoded pixels");
  let alphaMin = 255, alphaMax = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    alphaMin = Math.min(alphaMin, pixels[i]); alphaMax = Math.max(alphaMax, pixels[i]);
  }
  parentPort.postMessage({ width, height, alphaMin, alphaMax, hasTransparency: alphaMin < 255 });
} catch {
  parentPort.postMessage(null);
} finally {
  if (image) image.free();
}
`;

/** Inspection is best-effort, never permission to regenerate or discard an
 * already completed original. Header dimensions bound admission to decoding. */
export async function inspectImage(
  bytes: Buffer, outputFormat: OutputFormat, signal?: AbortSignal,
): Promise<MeasuredImage | undefined> {
  if (signal?.aborted) return undefined;
  let width: number, height: number;
  try {
    const dimensions = getImageDimensions(bytes.toString("base64"), `image/${outputFormat}`);
    if (!dimensions) return undefined;
    width = dimensions.widthPx;
    height = dimensions.heightPx;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > MAX_INSPECTION_PIXELS || height > MAX_INSPECTION_PIXELS
      || width * height > MAX_INSPECTION_PIXELS) return undefined;
  } catch { return undefined; }
  return new Promise(resolve => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (value?: MeasuredImage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker?.terminate().catch(() => undefined);
      resolve(value);
    };
    const abort = () => finish();
    try {
      worker = new Worker(INSPECT_WORKER, {
        eval: true,
        stdout: true,
        stderr: true,
        workerData: {
          bytes, width, height,
          modulePath: createRequire(import.meta.url).resolve("@silvia-odwyer/photon-node"),
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      // Decoder diagnostics can contain untrusted input details. Drain silently.
      worker.stdout?.resume();
      worker.stderr?.resume();
      worker.once("message", value => {
        if (!value || value.width !== width || value.height !== height
          || !Number.isInteger(value.alphaMin) || !Number.isInteger(value.alphaMax)
          || value.alphaMin < 0 || value.alphaMax > 255 || value.alphaMin > value.alphaMax) return finish();
        finish({ outputFormat, width, height, alphaMin: value.alphaMin, alphaMax: value.alphaMax, hasTransparency: value.alphaMin < 255 });
      });
      worker.once("error", () => finish());
      worker.once("exit", () => finish());
      timer = setTimeout(() => finish(), INSPECTION_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) finish();
    } catch { finish(); }
  });
}
