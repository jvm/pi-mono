export type ImageTransport = "responses" | "images";
export type ImageBackground = "auto" | "opaque" | "transparent";

/** This is the Codex subscription contract, not the public Images API.
 * No image-model selector, explicit dimensions/quality, GIF, or API fallback. */
export function buildImagesRequest(
  prompt: string,
  background: ImageBackground | undefined,
  images: readonly { data: string; mimeType: string }[],
) {
  return {
    prompt,
    background: background ?? (images.length ? "auto" : "opaque"),
    model: "gpt-image-2",
    quality: "auto",
    size: "auto",
    ...(images.length ? {
      images: images.map(image => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
    } : {}),
  };
}
