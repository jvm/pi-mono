import { type TUnsafe, Type } from "typebox";

/**
 * Plain `{ type: "string", enum: [...] }` schema typed for TypeBox's `Static`.
 *
 * Mirrors the `StringEnum` Pi injects for extensions. The published
 * `@earendil-works/pi-ai` package returns an untyped pi-schema `Schema`, which
 * loses inference inside `Type.Object`.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
