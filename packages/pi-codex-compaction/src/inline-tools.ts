type Item = Record<string, unknown>;
const isItem = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Mirror the effective loadout using exact provider-serialized declarations.
 * Preserve every input item and its position; never fold prompt/tool history.
 * Missing, foreign, ambiguous or oversized state fails closed.
 */
export function mirrorTools(payload: Item, currentNames: readonly string[] | undefined): Item | undefined {
  if (!Array.isArray(payload.input) || !currentNames?.length || currentNames.length > 1024 ||
      new Set(currentNames).size !== currentNames.length ||
      (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length > 0))) return;
  try { if (Buffer.byteLength(JSON.stringify(payload)) > 4 * 1024 * 1024) return; } catch { return; }
  const definitions = new Map<string, { tool: Item; group: string }>();
  const groups = new Map<string, Item>([["functions", {
    type: "namespace", name: "functions", description: "Tools available in the current Pi loadout.",
  }]]);
  let count = 0;
  let batches = 0;
  const batchNames = new Set<string>();
  const batchGroups = new Set<string>();
  function collect(value: unknown, group: string, nested = false): boolean {
    if (!isItem(value) || typeof value.name !== "string" || value.name.length === 0 || ++count > 1024) return false;
    if (value.type === "namespace") {
      if (nested || !Array.isArray(value.tools) || batchGroups.has(value.name)) return false;
      batchGroups.add(value.name);
      const { tools, ...metadata } = value;
      groups.set(value.name, metadata);
      return tools.every(tool => collect(tool, value.name as string, true));
    }
    if (value.type !== "function" && value.type !== "custom") return false;
    if (batchNames.has(value.name)) return false;
    batchNames.add(value.name);
    const previous = definitions.get(value.name);
    if (previous && previous.group !== group) return false;
    definitions.set(value.name, { tool: value, group });
    return true;
  }
  for (const item of payload.input) {
    if (!isItem(item) || item.type !== "additional_tools") continue;
    if (item.role !== "developer" || !Array.isArray(item.tools)) return;
    batches++;
    batchNames.clear();
    batchGroups.clear();
    if (!item.tools.every(tool => collect(tool, "functions"))) return;
  }
  if (batches === 0) return;
  const selected = new Map<string, Item[]>();
  for (const name of currentNames) {
    const definition = definitions.get(name);
    // Pi 1.4 applies prepareLoadout's hidden-declaration projection AFTER the
    // context_with_system handlers. Never resurrect a logically active tool
    // absent from the serialized wire history.
    if (!definition) continue;
    const tools = selected.get(definition.group) ?? [];
    tools.push(definition.tool);
    selected.set(definition.group, tools);
  }
  if (selected.size === 0) return;
  const tools = [...selected].map(([group, members]) => ({ ...groups.get(group), tools: structuredClone(members) }));
  return { ...payload, tools };
}

/** Object property order is irrelevant to schema identity; array order remains significant. */
function canonical(value: unknown): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : isItem(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(value));
}

/**
 * Promote the leading declaration once; do not duplicate it in input and tools.
 * Keep the initial base across additions while its exact visible definitions
 * still match. Pi's compaction checkpoint folds current tool state into the
 * first system message, so each checkpoint naturally starts a new base.
 * Never carry an older base through compaction: inline-only additions can lose
 * availability during the next compacted response, even with full inline replay.
 */
export function hybridTools(payload: Item, currentNames: readonly string[] | undefined): Item | undefined {
  const current = mirrorTools(payload, currentNames);
  if (!current || !Array.isArray(payload.input)) return;
  const index = payload.input.findIndex(item => isItem(item) && item.type === "additional_tools");
  // Remove only a leading loadout. If tools first appear later (e.g. a hidden
  // initial loadout followed by codemode activation), retain that native item
  // and establish the current namespace inventory without rewriting its history.
  if (payload.input.slice(0, index).some(item => !isItem(item) ||
      !["developer", "system"].includes(String(item.role)) ||
      (item.type !== undefined && item.type !== "message"))) return current;
  const first = payload.input[index] as Item;
  const input = payload.input.filter((_, i) => i !== index);
  const withCurrent = { ...current, input };
  const initialNames = (first.tools as Item[]).flatMap(tool => tool.type === "namespace"
    ? (tool.tools as Item[]).map(child => child.name as string) : [tool.name as string]);
  const base = mirrorTools({ input: [first] }, initialNames)?.tools;
  if (!Array.isArray(base) || base.length === 0 || base.length > 1024 ||
      base.some(tool => !isItem(tool) || tool.type !== "namespace" || !Array.isArray(tool.tools) ||
        tool.tools.length === 0 || tool.tools.some(child => !isItem(child) || typeof child.name !== "string"))) return withCurrent;
  const names = base.flatMap(tool => (tool.tools as Item[]).map(child => child.name as string));
  if (names.length > 1024 || new Set(names).size !== names.length) return withCurrent;
  if (!names.every(name => currentNames?.includes(name))) return withCurrent;
  const latestBase = mirrorTools(payload, names);
  try {
    if (!latestBase || canonical(base) !== canonical(latestBase.tools)) return withCurrent;
  } catch { return; }
  return { ...payload, input, tools: structuredClone(base) };
}
