#!/usr/bin/env node
// @ts-check
/**
 * Pure-Node port of Every Inc.'s `compound-engineering-plugin` CE-to-Pi
 * converter. Mirrors the logic in upstream `src/converters/claude-to-pi.ts`
 * and `src/targets/pi.ts` so that installing `pi-compound-engineering` over
 * a fresh checkout of CE 3.13.0 produces the same `skills/` and `agents/`
 * trees that the upstream Bun CLI would.
 *
 * This file is plain ESM JavaScript with JSDoc annotations — no transpile
 * step, no npm dependencies. It is invoked by `scripts/stage.mjs` during
 * the `preinstall` lifecycle hook and by `scripts/verify.mjs` for the
 * CI structure check.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   name: string,
 *   version?: string,
 *   description?: string,
 *   author?: { name?: string, email?: string, url?: string } | string,
 *   keywords?: string[],
 *   agents?: string | string[],
 *   commands?: string | string[],
 *   skills?: string | string[],
 * }} ClaudeManifest
 *
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   capabilities?: string[],
 *   model?: string,
 *   body: string,
 *   sourcePath: string,
 * }} ClaudeAgent
 *
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   ce_platforms?: string[],
 *   sourceDir: string,
 *   skillPath: string,
 * }} ClaudeSkill
 *
 * @typedef {{
 *   root: string,
 *   manifest: ClaudeManifest,
 *   agents: ClaudeAgent[],
 *   skills: ClaudeSkill[],
 * }} ClaudePlugin
 *
 * @typedef {{
 *   name: string,
 *   description: string,
 *   content: string,
 * }} PiAgent
 *
 * @typedef {{
 *   name: string,
 *   sourceDir: string,
 * }} PiSkillSource
 *
 * @typedef {{
 *   pluginName: string,
 *   skills: PiSkillSource[],
 *   agents: PiAgent[],
 * }} ConvertResult
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PI_DESCRIPTION_MAX_LENGTH = 1024;
const CE_PLATFORM = "pi";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a name for use as a filesystem path component.
 * Replaces colons with hyphens so colon-namespaced names
 * (e.g. "ce:brainstorm") become flat directory names ("ce-brainstorm").
 *
 * @param {string} name
 */
export function sanitizePathName(name) {
	return name.replace(/:/g, "-");
}

/**
 * Copy a file preserving its mode bits (e.g. the executable bit on
 * Python scripts). The default `fs.copyFile` only copies the content;
 * we explicitly re-apply the source mode afterwards.
 *
 * @param {string} source
 * @param {string} target
 */
async function copyFilePreservingMode(source, target) {
	const sourceStat = await stat(source);
	await copyFile(source, target);
	await chmod(target, sourceStat.mode & 0o777);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Markdown file with a YAML frontmatter block delimited by `---`.
 * Returns the frontmatter data as a plain object and the body as a string.
 *
 * The YAML is parsed using a hand-rolled, subset-only parser because we
 * need to avoid npm dependencies in the install-time script. The frontmatter
 * used by CE is small and predictable (string keys, scalar values, simple
 * arrays of strings, optional booleans). This parser handles:
 *
 *   - `key: value` string scalars
 *   - `key: 'quoted value with colons'`
 *   - `key: "double quoted"`
 *   - `key: true | false`
 *   - `key: [item1, item2]`
 *   - `key:` followed by an indented list of `- item` entries
 *
 * Anything more complex falls back to a string with a warning. For CE's
 * real content this is sufficient.
 *
 * @param {string} raw
 * @returns {{ data: Record<string, any>, body: string, startIndex: number, endIndex: number }}
 */
export function parseFrontmatter(raw) {
	const lines = raw.split(/\r?\n/);
	if (lines.length === 0 || lines[0].trim() !== "---") {
		return { data: {}, body: raw, startIndex: -1, endIndex: -1 };
	}

	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			endIndex = i;
			break;
		}
	}

	if (endIndex === -1) {
		return { data: {}, body: raw, startIndex: -1, endIndex: -1 };
	}

	const yamlText = lines.slice(1, endIndex).join("\n");
	const body = lines.slice(endIndex + 1).join("\n");
	const data = parseSimpleYaml(yamlText);
	return { data, body, startIndex: 0, endIndex };
}

/**
 * Parse a small subset of YAML frontmatter.
 *
 * @param {string} yaml
 * @returns {Record<string, any>}
 */
export function parseSimpleYaml(yaml) {
	const data = {};
	const lines = yaml.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		// Skip blank lines and comments
		if (!line.trim() || line.trim().startsWith("#")) {
			i++;
			continue;
		}
		// Skip list-continuation lines; they are handled in the key branch
		if (/^\s+-\s+/.test(line)) {
			i++;
			continue;
		}
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
		if (!match) {
			i++;
			continue;
		}
		const key = match[1];
		const rest = match[2];
		// Inline empty value: collect following indented list items
		if (rest === undefined || rest === "") {
			const arr = [];
			let j = i + 1;
			while (j < lines.length) {
				const next = lines[j];
				const listMatch = next.match(/^\s+-\s+(.*)$/);
				if (listMatch) {
					arr.push(unquoteScalar(listMatch[1]));
					j++;
				} else if (!next.trim()) {
					j++;
				} else {
					break;
				}
			}
			if (arr.length > 0) {
				data[key] = arr;
			} else {
				data[key] = null;
			}
			i = j;
			continue;
		}
		// Inline array: [a, b, c]
		if (rest.startsWith("[") && rest.endsWith("]")) {
			const inner = rest.slice(1, -1).trim();
			if (inner.length === 0) {
				data[key] = [];
			} else {
				data[key] = splitTopLevelCommas(inner).map((v) => unquoteScalar(v.trim()));
			}
			i++;
			continue;
		}
		data[key] = unquoteScalar(rest.trim());
		i++;
	}
	return data;
}

export function splitTopLevelCommas(str) {
	const result = [];
	let depth = 0;
	let buf = "";
	let quote = null;
	for (let i = 0; i < str.length; i++) {
		const ch = str[i];
		if (quote) {
			buf += ch;
			if (ch === quote && str[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === "[" || ch === "{") depth++;
		if (ch === "]" || ch === "}") depth--;
		if (ch === "," && depth === 0) {
			result.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) result.push(buf);
	return result;
}

export function unquoteScalar(value) {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		const inner = trimmed.slice(1, -1);
		return inner.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
	}
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null" || trimmed === "~") return null;
	if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
	return trimmed;
}

/**
 * Render a frontmatter object as a YAML block and combine it with the
 * body. Mirrors the upstream `formatFrontmatter(data, body)`:
 *   ---
 *   key: value
 *   ---
 *
 *   <body>
 *
 * @param {Record<string, any>} data
 * @param {string} [body]
 * @returns {string}
 */
export function formatFrontmatter(data, body = "") {
	const lines = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		lines.push(renderYamlLine(key, value));
	}
	const yaml = lines.join("\n");
	if (yaml.trim().length === 0) {
		return body;
	}
	return ["---", yaml, "---", "", body].join("\n");
}

function renderYamlLine(key, value) {
	if (Array.isArray(value)) {
		const items = value.map((v) => formatScalar(v)).join(", ");
		return `${key}: [${items}]`;
	}
	if (value === null) return `${key}:`;
	if (typeof value === "boolean" || typeof value === "number") return `${key}: ${value}`;
	return `${key}: ${formatScalar(value)}`;
}

function formatScalar(value) {
	if (value === null || value === undefined) return "";
	const str = String(value);
	if (str === "") return '""';
	if (/^[A-Za-z0-9_\-./]+$/.test(str) && !str.startsWith("-")) return str;
	// Always quote if it contains anything risky.
	return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Name normalisation (mirrors upstream `normalizeName`).
// ---------------------------------------------------------------------------

/**
 * @param {string} value
 */
export function normalizeName(value) {
	const trimmed = value.trim();
	if (!trimmed) return "item";
	const normalized = trimmed
		.toLowerCase()
		.replace(/[\\/]+/g, "-")
		.replace(/[:\s]+/g, "-")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "item";
}

/**
 * Truncate a string to at most `maxLength` characters, appending an
 * ellipsis if it was longer.
 *
 * @param {string} value
 * @param {number} maxLength
 */
export function sanitizeDescription(value, maxLength = PI_DESCRIPTION_MAX_LENGTH) {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	const ellipsis = "...";
	return normalized.slice(0, Math.max(0, maxLength - ellipsis.length)).trimEnd() + ellipsis;
}

// ---------------------------------------------------------------------------
// Text transformations (the load-bearing rewrite).
// Mirrors `transformContentForPi` in upstream `src/converters/claude-to-pi.ts`.
// ---------------------------------------------------------------------------

/**
 * Apply Pi-specific text transformations to a skill or agent body.
 *
 * @param {string} body
 * @param {object} [options]
 * @param {string} [options.skillName] - Sanitized skill directory name. When
 *   provided, backtick-wrapped `references/`, `scripts/`, and `assets/` paths
 *   are prefixed with `skills/<skillName>/` so they resolve against the
 *   package-root base path Pi injects for package-sourced skills. Omit for
 *   agent bodies (no resource rewrite) or any non-skill caller.
 */
export function transformContentForPi(body, options = {}) {
	const { skillName } = options;
	let result = body;

	// Task repo-research-analyst(feature_description) or Task compound-engineering:research:repo-research-analyst(args)
	// -> Run subagent with agent="repo-research-analyst" and task="feature_description"
	const taskPattern = /^(\s*-?\s*)Task\s+([a-z][a-z0-9:-]*)\(([^)]*)\)/gm;
	result = result.replace(taskPattern, (_match, prefix, agentName, args) => {
		const finalSegment = agentName.includes(":") ? agentName.split(":").pop() : agentName;
		const skillName = normalizeName(/** @type {string} */ (finalSegment));
		const trimmedArgs = String(args).trim().replace(/\s+/g, " ");
		return trimmedArgs
			? `${prefix}Run subagent with agent="${skillName}" and task="${trimmedArgs}".`
			: `${prefix}Run subagent with agent="${skillName}".`;
	});

	// Claude Code task-tracking primitives.
	result = result.replace(/\bTask(?:Create|Update|List|Get|Stop|Output)\b/g, "the platform's task-tracking primitive");
	result = result.replace(/\bTodoWrite\b/g, "the platform's task-tracking primitive");
	result = result.replace(/\bTodoRead\b/g, "the platform's task-tracking primitive");

	// /command-name -> /command-name (slash-command form).
	// The pi-compound-engineering package owns the prompt namespace, so no
	// `workflows-` or `pkg-` prefix is added. The upstream `claude-to-pi`
	// rewrite still applies the protective normalisations below.
	const slashCommandPattern = /(?<![:\w])\/([a-z][a-z0-9_:-]*?)(?=[\s,."')\]}`]|$)/gi;
	result = result.replace(slashCommandPattern, (match, commandName) => {
		const name = /** @type {string} */ (commandName);
		if (name.includes("/")) return match;
		if (["dev", "tmp", "etc", "usr", "var", "bin", "home"].includes(name)) {
			return match;
		}
		if (name.startsWith("skill:")) {
			const skillName = name.slice("skill:".length);
			return `/skill:${normalizeName(skillName)}`;
		}
		const withoutPrefix = name.startsWith("prompts:") ? name.slice("prompts:".length) : name;
		return `/${normalizeName(withoutPrefix)}`;
	});

	// Skill-local resource paths: `references/foo.md` -> `skills/<skill>/references/foo.md`.
	// Pi injects the package root as the base path for package-sourced skills, so
	// the bare relative paths upstream CE writes resolve one level too high.
	// Rewrite backtick-wrapped refs so they resolve on the first read attempt
	// with no model inference. Only backtick-wrapped paths are rewritten: real
	// resource refs are consistently backtick-wrapped, and this avoids touching
	// prose mentions, vendored man-page text, or paths inside fenced code blocks.
	if (skillName) {
		const resourceRefPattern = /`((?:references|scripts|assets)\/[A-Za-z0-9_./-]+)`/g;
		result = result.replace(resourceRefPattern, (_match, refPath) => {
			if (refPath.startsWith(`skills/${skillName}/`)) return _match;
			return `\`skills/${skillName}/${refPath}\``;
		});

		// Skill-local shell invocations: `bash scripts/check-health` -> `bash skills/<skill>/scripts/check-health`.
		// Pi executes shell commands from the project cwd, so un-backtick bare
		// `scripts/...` invocations fail. Only rewrite on lines that are a shell
		// command (after a known command prefix: bash, sh, ./, node, python3, etc.)
		// to avoid hitting prose mentions. Restricted to `scripts/` (not
		// `references/` or `assets/`) to keep the false-positive surface narrow;
		// the backtick pass above already covers inline refs.
		const commandPrefixPattern = /^(\s*)(bash|sh|\.\/|node|python3)(\s+)((?:scripts|references)\/[A-Za-z0-9_./-]+)/gm;
		result = result.replace(commandPrefixPattern, (match, indent, cmd, space, refPath) => {
			if (refPath.startsWith(`skills/${skillName}/`)) return match;
			return `${indent}${cmd}${space}skills/${skillName}/${refPath}`;
		});
	}

	return result;
}

// ---------------------------------------------------------------------------
// Plugin parsing
// ---------------------------------------------------------------------------

/**
 * @param {string} ceRoot Path to `plugins/compound-engineering/`
 * @returns {Promise<ClaudePlugin>}
 */
export async function parseClaudePlugin(ceRoot) {
	const manifestPath = join(ceRoot, ".claude-plugin", "plugin.json");
	const manifestRaw = await readFile(manifestPath, "utf8");
	const manifest = JSON.parse(manifestRaw);

	const skillsDir = join(ceRoot, "skills");
	const agentsDir = join(ceRoot, "agents");

	const [skills, agents] = await Promise.all([parseSkills(skillsDir), parseAgents(agentsDir)]);

	return { root: ceRoot, manifest, skills, agents };
}

/**
 * @param {string} skillsDir
 * @returns {Promise<ClaudeSkill[]>}
 */
async function parseSkills(skillsDir) {
	let entries;
	try {
		entries = await readdir(skillsDir, { withFileTypes: true });
	} catch (err) {
		if (err && /** @type {any} */ (err).code === "ENOENT") return [];
		throw err;
	}
	const skills = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillDir = join(skillsDir, entry.name);
		const skillFile = join(skillDir, "SKILL.md");
		let raw;
		try {
			raw = await readFile(skillFile, "utf8");
		} catch (err) {
			if (err && /** @type {any} */ (err).code === "ENOENT") continue;
			throw err;
		}
		const { data } = parseFrontmatter(raw);
		skills.push({
			name: typeof data.name === "string" ? data.name : entry.name,
			description: typeof data.description === "string" ? data.description : undefined,
			ce_platforms: Array.isArray(data.ce_platforms)
				? /** @type {any[]} */ (data.ce_platforms).filter((v) => typeof v === "string")
				: undefined,
			sourceDir: skillDir,
			skillPath: skillFile,
		});
	}
	return skills;
}

/**
 * @param {string} agentsDir
 * @returns {Promise<ClaudeAgent[]>}
 */
async function parseAgents(agentsDir) {
	let entries;
	try {
		entries = await readdir(agentsDir, { withFileTypes: true });
	} catch (err) {
		if (err && /** @type {any} */ (err).code === "ENOENT") return [];
		throw err;
	}
	const agents = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const sourcePath = join(agentsDir, entry.name);
		const raw = await readFile(sourcePath, "utf8");
		const { data, body } = parseFrontmatter(raw);
		const name = typeof data.name === "string" ? data.name : entry.name.replace(/\.md$/, "");
		agents.push({
			name,
			description: typeof data.description === "string" ? data.description : undefined,
			model: typeof data.model === "string" ? data.model : undefined,
			body,
			sourcePath,
		});
	}
	return agents;
}

/**
 * Filter skills to those available on a given platform. Skills without a
 * `ce_platforms` field are available everywhere.
 *
 * @param {ClaudeSkill[]} skills
 * @param {string} platform
 */
function filterSkillsByPlatform(skills, platform) {
	return skills.filter((skill) => !skill.ce_platforms || skill.ce_platforms.includes(platform));
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * @param {ClaudePlugin} plugin
 * @returns {ConvertResult}
 */
export function convertClaudeToPi(plugin) {
	const platformSkills = filterSkillsByPlatform(plugin.skills, CE_PLATFORM);
	return {
		pluginName: plugin.manifest.name,
		skills: platformSkills.map((skill) => ({
			name: skill.name,
			sourceDir: skill.sourceDir,
		})),
		agents: plugin.agents.map(convertAgent),
	};
}

/**
 * @param {ClaudeAgent} agent
 * @returns {PiAgent}
 */
function convertAgent(agent) {
	const name = normalizeName(agent.name);
	const description = sanitizeDescription(
		agent.description ?? `Converted from Claude agent ${agent.name}`,
	);
	const frontmatter = {
		name,
		description,
	};
	const body = agent.body.trim().length > 0
		? agent.body.trim()
		: `Instructions converted from the ${agent.name} agent.`;
	return {
		name,
		description,
		content: formatFrontmatter(frontmatter, body),
	};
}

// ---------------------------------------------------------------------------
// File emission
// ---------------------------------------------------------------------------

/**
 * Copy a skill directory to the target, transforming `SKILL.md` and any
 * nested `*.md` reference files. Non-markdown files (e.g. `assets/`,
 * `scripts/`) are copied verbatim, preserving the executable bit.
 *
 * @param {string} sourceDir
 * @param {string} targetDir
 * @param {string} [skillName] - Sanitized skill name for resource-path
 *   rewriting in `SKILL.md` and nested `.md` files. Derived from `targetDir`
 *   when omitted at the top level; left undefined in recursive calls so
 *   nested `.md` files inherit the top-level skill name rather than the
 *   subdirectory name.
 */
export async function copySkillDir(sourceDir, targetDir, skillName) {
	await mkdir(targetDir, { recursive: true });
	const entries = await readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			await copySkillDir(sourcePath, targetPath, skillName);
		} else if (entry.isFile()) {
			if (entry.name === "SKILL.md" || entry.name.endsWith(".md")) {
				const content = await readFile(sourcePath, "utf8");
				const transformed = transformContentForPi(content, { skillName });
				await writeFile(targetPath, transformed, "utf8");
			} else {
				await copyFilePreservingMode(sourcePath, targetPath);
			}
		}
	}
}

/**
 * Write a single agent as a `.md` file with the converted content.
 *
 * @param {PiAgent} agent
 * @param {string} agentsDir
 */
async function writeAgent(agent, agentsDir) {
	const target = join(agentsDir, `${sanitizePathName(agent.name)}.md`);
	await writeFile(target, agent.content, "utf8");
	return target;
}

/**
 * Build the THIRD-PARTY-NOTICES content for the install. Lists every
 * converted file with its upstream source path.
 *
 * @param {string} ceRoot
 * @param {string} ceVersion
 * @param {ConvertResult} result
 * @returns {Promise<string>}
 */
export async function buildThirdPartyNotices(ceRoot, ceVersion, result) {
	const lines = [];
	lines.push("pi-compound-engineering THIRD-PARTY-NOTICES");
	lines.push("=========================================");
	lines.push("");
	lines.push(`Synced from Every Inc.'s compound-engineering-plugin v${ceVersion}.`);
	lines.push(`Upstream: https://github.com/EveryInc/compound-engineering-plugin/tree/cli-v${ceVersion}`);
	lines.push(`Upstream tarball: https://codeload.github.com/EveryInc/compound-engineering-plugin/tar.gz/refs/tags/cli-v${ceVersion}`);
	lines.push("");
	lines.push("Every Inc. and Kieran Klaassen retain copyright to the original");
	lines.push("content. The plugin is licensed under the MIT License. See the");
	lines.push("upstream LICENSE for the full text:");
	lines.push("https://github.com/EveryInc/compound-engineering-plugin/blob/main/LICENSE");
	lines.push("");
	lines.push("The files below were generated by scripts/converter.mjs at install time");
	lines.push("from the upstream tarball. Source paths are relative to the upstream");
	lines.push("`plugins/compound-engineering/` directory.");
	lines.push("");
	lines.push("Skills (one SKILL.md per entry; references/ and assets/ copied verbatim):");
	lines.push("");
	for (const skill of result.skills) {
		const upstream = relative(ceRoot, skill.sourceDir);
		lines.push(`  ${upstream}/SKILL.md`);
		try {
			const all = await readdir(skill.sourceDir, { withFileTypes: true });
			for (const sub of all) {
				if (sub.name === "SKILL.md") continue;
				if (sub.isDirectory()) {
					lines.push(`  ${upstream}/${sub.name}/`);
				} else {
					lines.push(`  ${upstream}/${sub.name}`);
				}
			}
		} catch {
			// ignore unreadable subdirs
		}
	}
	lines.push("");
	lines.push("Agents:");
	lines.push("");
	// PiAgent only carries the normalized `name`, not the original
	// upstream filename. Look up the actual source file by reading the
	// upstream agents dir and matching the normalized name back to the
	// raw filename (e.g. an upstream file named "CE API Contract
	// Reviewer.md" normalizes to "ce-api-contract-reviewer.md" and the
	// notices must point at the real upstream file, not the
	// normalized one).
	const upstreamAgentFiles = await readdir(join(ceRoot, "agents"));
	for (const agent of result.agents) {
		const upstreamName = upstreamAgentFiles.find(
			(file) => file.endsWith(".md") && normalizeName(file.slice(0, -3)) === agent.name,
		);
		const sourceName = upstreamName ?? `${agent.name}.md`;
		lines.push(`  ${relative(ceRoot, join(ceRoot, "agents", sourceName))}`);
	}
	lines.push("");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Convert the upstream CE plugin at `ceRoot` and write the result to
 * `outputDir`. Produces:
 *   - <outputDir>/skills/<name>/SKILL.md
 *   - <outputDir>/agents/<name>.md
 *   - <outputDir>/THIRD-PARTY-NOTICES
 *
 * @param {string} ceRoot
 * @param {string} outputDir
 * @param {string} ceVersion
 * @returns {Promise<ConvertResult>}
 */
export async function convert(ceRoot, outputDir, ceVersion) {
	const plugin = await parseClaudePlugin(ceRoot);
	const result = convertClaudeToPi(plugin);

	const skillsDir = join(outputDir, "skills");
	const agentsDir = join(outputDir, "agents");
	await mkdir(skillsDir, { recursive: true });
	await mkdir(agentsDir, { recursive: true });

	for (const skill of result.skills) {
		const targetDir = join(skillsDir, sanitizePathName(skill.name));
		await copySkillDir(skill.sourceDir, targetDir, sanitizePathName(skill.name));
	}

	for (const agent of result.agents) {
		await writeAgent(agent, agentsDir);
	}

	// Generate THIRD-PARTY-NOTICES.
	const notices = await buildThirdPartyNotices(ceRoot, ceVersion, result);
	await writeFile(join(outputDir, "THIRD-PARTY-NOTICES"), notices, "utf8");

	return result;
}

// ---------------------------------------------------------------------------
// SHA256 streaming helper (used by stage.mjs)
// ---------------------------------------------------------------------------

/**
 * Compute the SHA256 of a file by streaming. Returns a lowercase hex string.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256OfFile(filePath) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(filePath), hash);
	return hash.digest("hex");
}

/**
 * Stream a `fetch` response body to a file. Returns the file path written.
 *
 * @param {Response} response
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function streamResponseToFile(response, filePath) {
	if (!response.body) {
		throw new Error("Response body is empty");
	}
	const body = /** @type {NodeJS.ReadableStream} */ (response.body);
	await pipeline(body, createWriteStream(filePath));
	return filePath;
}
