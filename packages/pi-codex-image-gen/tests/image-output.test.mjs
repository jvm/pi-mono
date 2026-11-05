import assert from "node:assert/strict";
import test from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { detectOutputFormat, inspectImage, MAX_INSPECTION_PIXELS } from "../.test-dist/src/image-output.js";

const image = new PhotonImage(Uint8Array.from([255, 0, 0, 0, 0, 0, 255, 128]), 2, 1);
const PNG = Buffer.from(image.get_bytes());
const JPEG = Buffer.from(image.get_bytes_jpeg(90));
const WEBP = Buffer.from(image.get_bytes_webp());
image.free();

for (const [format, bytes] of [["png", PNG], ["jpeg", JPEG], ["webp", WEBP]]) {
  test(`pixel inspection measures actual ${format} output`, async () => {
    assert.equal(detectOutputFormat(bytes), format);
    const measured = await inspectImage(bytes, format);
    assert.equal(measured.width, 2);
    assert.equal(measured.height, 1);
    assert.equal(measured.outputFormat, format);
    assert.equal(measured.hasTransparency, format !== "jpeg");
    assert.equal(measured.alphaMin, format === "jpeg" ? 255 : 0);
    assert.equal(measured.alphaMax, format === "jpeg" ? 255 : 128);
  });
}

test("inspection skips malformed images, pixel bombs, and cancelled work", async () => {
  assert.throws(() => detectOutputFormat(Buffer.from("not an image")), /unsupported image format/);
  assert.equal(await inspectImage(PNG.subarray(0, 8), "png"), undefined);
  const bomb = Buffer.from(PNG);
  bomb.writeUInt32BE(MAX_INSPECTION_PIXELS, 16);
  bomb.writeUInt32BE(2, 20);
  assert.equal(await inspectImage(bomb, "png"), undefined);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await inspectImage(PNG, "png", aborted.signal), undefined);
});

test("inspection cancellation terminates an active worker without leaking pixels", async () => {
  const controller = new AbortController();
  const pending = inspectImage(PNG, "png", controller.signal);
  controller.abort();
  assert.equal(await pending, undefined);
});
