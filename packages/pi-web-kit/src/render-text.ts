import { stripVTControlCharacters } from "node:util";
import { redactText } from "./output.js";

/** Untrusted labels are plain text, never terminal commands or extra rows. */
export function singleLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripVTControlCharacters(redactText(value))
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
}
