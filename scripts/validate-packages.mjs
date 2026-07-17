import { readFile, readdir } from "node:fs/promises";

const packagesDir = new URL("../packages/", import.meta.url);
const requiredFiles = [
  "package.json", "tsconfig.json", ".editorconfig", ".gitignore", "AGENTS.md", "README.md",
  "CHANGELOG.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md",
];
const basePublishedFiles = [
  "index.ts", "extensions", "src", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md",
  "CONTRIBUTING.md", "CODE_OF_CONDUCT.md",
];
const requiredScripts = ["check", "typecheck", "test", "pack:dry-run"];
const sharedVersions = new Map();
const errors = [];

async function text(url) {
  return readFile(url, "utf8");
}

async function json(url) {
  return JSON.parse(await text(url));
}

const slugs = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const rootReadme = await text(new URL("../README.md", import.meta.url));
const canonicalEditorConfig = await text(new URL("../templates/package/.editorconfig", import.meta.url));
const canonicalGitignoreLines = (await text(new URL("../templates/package/.gitignore", import.meta.url))).trim().split("\n");

for (const slug of slugs) {
  const dir = new URL(`${slug}/`, packagesDir);
  const entries = new Set(await readdir(dir));
  for (const file of requiredFiles) {
    if (!entries.has(file)) errors.push(`${slug}: missing ${file}`);
  }
  if (!entries.has("package.json")) continue;

  const manifest = await json(new URL("package.json", dir));
  const extensionEntries = manifest.pi?.extensions ?? [];
  const isExtension = extensionEntries.length > 0;

  if (!(manifest.name?.startsWith("pi-") || manifest.name === "@mocito/pi-goal")) errors.push(`${slug}: invalid package name`);
  if (manifest.type !== "module") errors.push(`${slug}: type must be module`);
  if (manifest.author !== "Jose Mocito") errors.push(`${slug}: author must be Jose Mocito`);
  if (manifest.engines?.node !== ">=20.6.0") errors.push(`${slug}: engines.node must be >=20.6.0`);
  if (manifest.publishConfig?.access !== "public") errors.push(`${slug}: publishConfig.access must be public`);
  if (manifest.repository?.directory !== `packages/${slug}`) errors.push(`${slug}: repository.directory mismatch`);
  if (!manifest.homepage?.includes(`/packages/${slug}#readme`)) errors.push(`${slug}: homepage mismatch`);

  for (const script of requiredScripts) {
    if (!manifest.scripts?.[script]) errors.push(`${slug}: missing script ${script}`);
  }
  for (const keyword of ["pi-package", ...(isExtension ? ["pi-extension", "pi"] : [])]) {
    if (!manifest.keywords?.includes(keyword)) errors.push(`${slug}: missing keyword ${keyword}`);
  }
  for (const file of basePublishedFiles) {
    if (!manifest.files?.includes(file)) errors.push(`${slug}: files missing ${file}`);
  }
  if (isExtension && (extensionEntries.length !== 1 || extensionEntries[0] !== "./index.ts")) {
    errors.push(`${slug}: pi.extensions must be [\"./index.ts\"]`);
  }
  if (isExtension) {
    const index = entries.has("index.ts") ? await text(new URL("index.ts", dir)) : "";
    if (!index.includes('export { default } from "./extensions/index.js"')) errors.push(`${slug}: invalid root extension re-export`);
    const telemetry = entries.has("src") ? await text(new URL("extensions/index.ts", dir)).catch(() => "") : "";
    if (!telemetry.includes("reportInstallTelemetry();")) errors.push(`${slug}: extension does not call install telemetry`);
    if (!entries.has("src") || !(await readdir(new URL("src/", dir))).includes("install-telemetry.ts")) errors.push(`${slug}: missing install telemetry module`);
  }

  for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (dependency.startsWith("@earendil-works/") && range !== "*") errors.push(`${slug}: ${dependency} peer range must be *`);
    if (dependency.startsWith("@earendil-works/") && !manifest.devDependencies?.[dependency]) errors.push(`${slug}: ${dependency} missing dev dependency`);
  }
  for (const dependency of ["typescript", "@types/node", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    const range = manifest.devDependencies?.[dependency];
    if (!range) continue;
    const previous = sharedVersions.get(dependency);
    if (previous && previous.range !== range) errors.push(`${slug}: ${dependency} ${range} differs from ${previous.slug} ${previous.range}`);
    else sharedVersions.set(dependency, { slug, range });
  }

  const agents = entries.has("AGENTS.md") ? await text(new URL("AGENTS.md", dir)) : "";
  for (const heading of ["## Invariants", "## Validation"]) {
    if (!agents.includes(heading)) errors.push(`${slug}: AGENTS.md missing ${heading}`);
  }
  const editorConfig = entries.has(".editorconfig") ? await text(new URL(".editorconfig", dir)) : "";
  if (editorConfig !== canonicalEditorConfig) errors.push(`${slug}: .editorconfig differs from template`);
  const gitignore = entries.has(".gitignore") ? await text(new URL(".gitignore", dir)) : "";
  for (const line of canonicalGitignoreLines) {
    if (!gitignore.split("\n").includes(line)) errors.push(`${slug}: .gitignore missing ${line}`);
  }

  const tsconfig = entries.has("tsconfig.json") ? await json(new URL("tsconfig.json", dir)) : {};
  const expectedOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true };
  for (const [key, value] of Object.entries(expectedOptions)) {
    if (tsconfig.compilerOptions?.[key] !== value) errors.push(`${slug}: tsconfig compilerOptions.${key} mismatch`);
  }
  if (!tsconfig.compilerOptions?.types?.includes("node")) errors.push(`${slug}: tsconfig must include node types`);
  if (!rootReadme.includes(`./packages/${slug}`)) errors.push(`${slug}: missing from root README index`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${slugs.length} packages.`);
}
