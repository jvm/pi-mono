/** Plain, bounded text only: never interpret command controls as terminal input. */
export function commandPreview(cmd: string): string {
  return JSON.stringify(cmd.slice(0, 256)).slice(1, -1)
    .replace(/[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    + (cmd.length > 256 ? "…" : "");
}
