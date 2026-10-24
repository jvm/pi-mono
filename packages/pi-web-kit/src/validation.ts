export function parseInteger(value: unknown, defaultValue: number, name: string, min: number, max?: number): number {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < min || (max != null && value > max)) {
    throw new Error(`${name} must be a finite integer ${max == null ? `>= ${min}` : `between ${min} and ${max}`}.`);
  }
  return value;
}
