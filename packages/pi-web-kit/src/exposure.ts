/** Bounded, branch-local bookkeeping. No credentials or provider configuration. */
export const WEB_TOOLS = new Set(["web_search", "web_fetch", "library_search", "library_docs", "code_search"]);
export type Exposure = "direct" | "deferred" | "hidden";
export interface Registration {
  version: 1 | 2;
  tools: string[];
  exposure?: Exposure;
  directActive?: string[];
  declared?: string[];
  positive?: string[];
}
export interface ExposureState extends Registration {
  version: 2;
  exposure: Exposure;
  directActive: string[];
  declared: string[];
  positive: string[];
}

export function names(values: readonly string[]): string[] {
  return [...new Set(values.filter(name => WEB_TOOLS.has(name)))].sort();
}

function validNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= WEB_TOOLS.size
    && value.every(name => typeof name === "string" && WEB_TOOLS.has(name));
}

export function readRegistration(value: unknown): Registration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if ((data.version !== 1 && data.version !== 2) || !validNames(data.tools)) return undefined;
  const exposure = data.exposure;
  const validExposure = exposure === "direct" || exposure === "deferred" || exposure === "hidden";
  if (data.version === 1) return { version: 1, tools: names(data.tools), ...(validExposure ? { exposure } : {}) };
  if (!validExposure || !validNames(data.directActive) || !validNames(data.declared) || !validNames(data.positive)) return undefined;
  return { version: 2, tools: names(data.tools), exposure,
    directActive: names(data.directActive), declared: names(data.declared), positive: names(data.positive) };
}

/** Automatic undeclaration is not a manual disable. Only compare real choices
 * with our last applied declaration set, never with an assumed all-active set.
 * On startup, transcript restoration may still be incomplete: prefer our saved
 * selection and let explicit settings/exclusions apply independently. */
export function directSelection(
  previous: Registration | undefined, active: readonly string[], available: readonly string[],
  positive: readonly string[], disabled: (name: string) => boolean, observe: boolean,
): string[] {
  const selected = new Set(previous?.directActive ?? names(active));
  if (observe && previous?.declared && previous.exposure !== "hidden") {
    for (const name of active) if (WEB_TOOLS.has(name) && !previous.declared.includes(name)) selected.add(name);
    for (const name of previous.declared) if (!active.includes(name)) selected.delete(name);
  }
  // Old/missing history on reload cannot establish that a positive setting is
  // new. Native active/pending restoration remains authoritative in that case.
  for (const name of positive) {
    if ((!previous || (previous.positive && !previous.positive.includes(name))) && !disabled(name)) selected.add(name);
  }
  for (const name of available) if (!previous?.tools.includes(name) && !disabled(name)) selected.add(name);
  return names([...selected]);
}
