import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverOllamaProvider } from "../src/index.js";

export default async function (pi: ExtensionAPI) {
  const provider = await discoverOllamaProvider();
  pi.registerProvider("ollama", provider);
}
