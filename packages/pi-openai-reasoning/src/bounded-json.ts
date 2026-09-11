/**
 * Keep native JSON ordering/escaping, but stop its traversal before it builds an
 * oversized result. Only ordinary JSON containers are needed for provider input.
 */
export function boundedStringify(input: unknown, maxBytes: number): string | undefined {
  let remaining = maxBytes;
  let root = true;
  const populated = new WeakSet<object>();
  const isRawJSON = (JSON as { isRawJSON?: (value: unknown) => boolean }).isRawJSON;
  const rejected = new Error("JSON fingerprint budget exceeded or unsupported value");

  function spend(bytes: number): void {
    remaining -= bytes;
    if (remaining < 0) throw rejected;
  }

  function quoted(text: string): void {
    // UTF-16 length is a cheap lower bound, including for a huge single input.
    if (text.length + 2 > remaining) throw rejected;
    let bytes = 2;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || code === 8 || code === 9 ||
        code === 10 || code === 12 || code === 13) bytes += 2;
      else if (code < 32) bytes += 6;
      else if (code < 128) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(index + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index++;
        } else bytes += 6; // Native JSON escapes an unpaired surrogate.
      } else bytes += 3;
      if (bytes > remaining) throw rejected;
    }
    spend(bytes);
  }

  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return;
    return JSON.stringify(input, function (key, value: unknown) {
      const omitted = value === undefined || typeof value === "function" || typeof value === "symbol";
      if (omitted && !Array.isArray(this)) return undefined;
      if (root) root = false;
      else {
        if (populated.has(this)) spend(1); // Comma between emitted children.
        populated.add(this);
        if (!Array.isArray(this)) {
          quoted(key);
          spend(1); // Colon.
        }
      }
      if (value === null || omitted) spend(4);
      else if (typeof value === "string") quoted(value);
      else if (typeof value === "number") spend(Number.isFinite(value) ? String(value).length : 4);
      else if (typeof value === "boolean") spend(value ? 4 : 5);
      else if (typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if (isRawJSON?.(value) ||
          !Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw rejected;
        spend(2); // Opening and closing brackets/braces.
        populated.delete(value); // A shared, non-cyclic container may recur.
      } else throw rejected;
      return value;
    });
  } catch {
    return undefined;
  }
}
