import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type PackageName = string;

interface PackageInfo {
  name: PackageName;
  slug: string;
  dir: string;
  version?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface ReleasePlan {
  packageName: PackageName;
  version: string;
  packageDir: string;
  tag: string;
  hasChanges: boolean;
  commands: string[];
}

interface FileSnapshot {
  path: string;
  content?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function discoverPackages(cwd: string): PackageInfo[] {
  const packagesDir = join(cwd, "packages");
  if (!existsSync(packagesDir)) return [];

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): PackageInfo[] => {
      const dir = `packages/${entry.name}`;
      const packageJsonPath = join(cwd, dir, "package.json");
      if (!existsSync(packageJsonPath)) return [];

      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: string;
          private?: boolean;
          version?: string;
        };
        if (!packageJson.name || packageJson.private) return [];
        return [{ name: packageJson.name, slug: entry.name, dir, version: packageJson.version }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseArgs(args: string): { packageName: PackageName; version?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) {
    throw new Error("Usage: /release-package <package> [version]");
  }

  const [packageName, version] = parts;
  if (!/^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/.test(packageName)) {
    throw new Error(`Invalid package name: ${packageName}`);
  }
  if (version && !isSemver(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return { packageName, version };
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function suggestNextPatchVersion(version: string | undefined): string {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Cannot suggest next version from current version: ${version ?? "<missing>"}`);
  }
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function findPackage(cwd: string, packageIdentifier: PackageName): PackageInfo {
  const packages = discoverPackages(cwd);
  const packageInfo = packages.find((pkg) => pkg.name === packageIdentifier || pkg.slug === packageIdentifier);
  if (!packageInfo) {
    const expected = packages.map((pkg) => (pkg.name === pkg.slug ? pkg.name : `${pkg.slug} (${pkg.name})`)).join(", ") || "no publishable packages found";
    throw new Error(`Unknown package: ${packageIdentifier}. Expected one of: ${expected}`);
  }
  return packageInfo;
}

function snapshotFiles(paths: string[]): FileSnapshot[] {
  return paths.map((path) => ({ path, content: existsSync(path) ? readFileSync(path, "utf8") : undefined }));
}

function restoreFiles(snapshots: FileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.content !== undefined) writeFileSync(snapshot.path, snapshot.content);
  }
}

function updateJsonFile(path: string, update: (value: any) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8"));
  update(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function prepareSuggestedVersion(cwd: string, packageInfo: PackageInfo, version: string): void {
  const packageJsonPath = join(cwd, packageInfo.dir, "package.json");
  const changelogPath = join(cwd, packageInfo.dir, "CHANGELOG.md");
  const packageLockPath = join(cwd, "package-lock.json");

  updateJsonFile(packageJsonPath, (packageJson) => {
    packageJson.version = version;
  });

  if (existsSync(packageLockPath)) {
    updateJsonFile(packageLockPath, (packageLock) => {
      if (packageLock.packages?.[packageInfo.dir]) packageLock.packages[packageInfo.dir].version = version;
    });
  }

  if (!existsSync(changelogPath)) return;
  const changelog = readFileSync(changelogPath, "utf8");
  if (changelog.includes(`## ${version}`)) return;
  const today = new Date().toISOString().slice(0, 10);
  const unreleased = "## Unreleased";
  const next = changelog.includes(unreleased)
    ? changelog.replace(unreleased, `## Unreleased\n\n## ${version} - ${today}`)
    : changelog.replace("# Changelog\n", `# Changelog\n\n## ${version} - ${today}\n`);
  writeFileSync(changelogPath, next);
}

async function run(command: string, cwd: string): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(`Command failed with exit code ${code}: ${command}${output ? `\n${output}` : ""}`));
      }
    });
  });
}

async function runQuiet(command: string, cwd: string): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command}\n${stderr || stdout}`));
      }
    });
  });
}

function parseGitStatus(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function ensureCleanEnoughForPackage(statusPaths: string[], packageDir: string): void {
  const allowed = new Set(["package.json", "package-lock.json"]);
  const unrelated = statusPaths.filter((path) => !path.startsWith(`${packageDir}/`) && !allowed.has(path));
  if (unrelated.length > 0) {
    throw new Error(
      `Working tree has changes outside ${packageDir}:\n${unrelated.map((path) => `- ${path}`).join("\n")}`,
    );
  }
}

async function buildPlan(cwd: string, packageIdentifier: PackageName, version: string): Promise<ReleasePlan> {
  const packageInfo = findPackage(cwd, packageIdentifier);
  const packageName = packageInfo.name;
  const packageDir = packageInfo.dir;
  const packageJsonPath = join(cwd, packageDir, "package.json");
  const changelogPath = join(cwd, packageDir, "CHANGELOG.md");
  const tag = `${packageName}@${version}`;

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; private?: boolean; version?: string };
  if (packageJson.name !== packageName) {
    throw new Error(`Package name mismatch in ${packageJsonPath}: expected ${packageName}, got ${packageJson.name}`);
  }
  if (packageJson.private) {
    throw new Error(`Cannot release private package: ${packageName}`);
  }
  if (packageJson.version !== version) {
    throw new Error(`Version mismatch: ${packageDir}/package.json is ${packageJson.version}, requested ${version}`);
  }

  if (!existsSync(changelogPath)) {
    throw new Error(`Missing changelog: ${changelogPath}`);
  }
  const changelog = readFileSync(changelogPath, "utf8");
  if (!changelog.includes(version)) {
    throw new Error(`CHANGELOG.md does not mention version ${version}`);
  }

  const branch = (await runQuiet("git branch --show-current", cwd)).stdout.trim();
  if (branch !== "main") {
    throw new Error(`Releases must be run from main. Current branch: ${branch || "detached HEAD"}`);
  }

  const existingTag = await runQuiet(`git tag --list ${shellQuote(tag)}`, cwd);
  if (existingTag.stdout.trim()) {
    throw new Error(`Tag already exists: ${tag}`);
  }

  const status = await runQuiet("git status --short", cwd);
  const statusPaths = parseGitStatus(status.stdout);
  ensureCleanEnoughForPackage(statusPaths, packageDir);
  const hasChanges = statusPaths.length > 0;

  const commands = [
    `npm run check --workspace ${packageDir}`,
    `npm test --workspace ${packageDir} --if-present`,
    `npm run pack:dry-run --workspace ${packageDir}`,
    "npm audit --omit=dev",
    "git status --short",
  ];

  if (hasChanges) {
    commands.push(
      `git add ${packageDir} package.json package-lock.json`,
      `git commit -m ${shellQuote(`Release ${packageName} ${version}`)}`,
    );
  } else {
    commands.push("# no package changes to commit");
  }

  commands.push(
    `git tag ${shellQuote(tag)}`,
    `git push origin main ${shellQuote(tag)}`,
    `gh release create ${shellQuote(tag)} --title ${shellQuote(tag)} --notes ${shellQuote(`Release ${packageName} ${version}.`)}`,
  );

  return { packageName, version, packageDir, tag, hasChanges, commands };
}

function formatPlan(plan: ReleasePlan): string {
  return [
    `Release plan`,
    ``,
    `Package: ${plan.packageName}`,
    `Version: ${plan.version}`,
    `Workspace: ${plan.packageDir}`,
    `Tag: ${plan.tag}`,
    `Commit package changes: ${plan.hasChanges ? "yes" : "no"}`,
    ``,
    `Commands:`,
    ...plan.commands.map((command) => `  ${command}`),
  ].join("\n");
}

async function executePlan(cwd: string, plan: ReleasePlan, onProgress?: (label: string) => void): Promise<void> {
  onProgress?.("Type checking");
  await run(`npm run check --workspace ${plan.packageDir}`, cwd);
  onProgress?.("Running tests");
  await run(`npm test --workspace ${plan.packageDir} --if-present`, cwd);
  onProgress?.("Validating package");
  await run(`npm run pack:dry-run --workspace ${plan.packageDir}`, cwd);
  onProgress?.("Auditing dependencies");
  await run("npm audit --omit=dev", cwd);
  onProgress?.("Checking git status");
  await run("git status --short", cwd);

  if (plan.hasChanges) {
    onProgress?.("Staging package changes");
    await run(`git add ${plan.packageDir} package.json package-lock.json`, cwd);
    onProgress?.("Committing release");
    await run(`git commit -m ${shellQuote(`Release ${plan.packageName} ${plan.version}`)}`, cwd);
  }

  onProgress?.("Creating git tag");
  await run(`git tag ${shellQuote(plan.tag)}`, cwd);
  onProgress?.("Pushing to remote");
  await run(`git push origin main ${shellQuote(plan.tag)}`, cwd);
  onProgress?.("Creating GitHub release");
  await run(
    `gh release create ${shellQuote(plan.tag)} --title ${shellQuote(plan.tag)} --notes ${shellQuote(
      `Release ${plan.packageName} ${plan.version}.`,
    )}`,
    cwd,
  );
}

export default function releaseExtension(pi: ExtensionAPI) {
  pi.registerCommand("release-package", {
    description: "Validate, tag, push, and create a GitHub release for a pi-mono package",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const packages = discoverPackages(process.cwd());
      const [first = "", second = ""] = prefix.split(/\s+/, 2);
      if (prefix.includes(" ")) {
        const packageInfo = packages.find((pkg) => pkg.name === first || pkg.slug === first);
        if (!packageInfo) return null;
        let suggested: string;
        try {
          suggested = suggestNextPatchVersion(packageInfo.version);
        } catch {
          return null;
        }
        if (suggested.startsWith(second)) {
          return [{ value: `${packageInfo.slug} ${suggested}`, label: `${suggested} (next patch)` }];
        }
        return null;
      }

      const items = packages
        .filter((pkg) => pkg.slug.startsWith(first) || pkg.name.startsWith(first))
        .map((pkg) => ({ value: pkg.slug, label: pkg.name === pkg.slug ? pkg.slug : `${pkg.slug} (${pkg.name})` }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        const cwd = process.cwd();
        const { packageName, version: requestedVersion } = parseArgs(args);
        let version = requestedVersion;
        let preparedSnapshots: FileSnapshot[] | undefined;
        if (!version) {
          const packageInfo = findPackage(cwd, packageName);
          version = suggestNextPatchVersion(packageInfo.version);
          const confirmedVersion = await ctx.ui.confirm(
            "Use suggested version?",
            `Current version for ${packageInfo.name} is ${packageInfo.version}.\n\nPrepare and release ${version}?`,
          );
          if (!confirmedVersion) {
            ctx.ui.notify("Release cancelled", "info");
            return;
          }
          preparedSnapshots = snapshotFiles([
            join(cwd, packageInfo.dir, "package.json"),
            join(cwd, "package-lock.json"),
            join(cwd, packageInfo.dir, "CHANGELOG.md"),
          ]);
          prepareSuggestedVersion(cwd, packageInfo, version);
        }
        let plan: ReleasePlan;
        let formattedPlan: string;
        try {
          plan = await buildPlan(cwd, packageName, version);
          formattedPlan = formatPlan(plan);
        } catch (error) {
          if (preparedSnapshots) restoreFiles(preparedSnapshots);
          throw error;
        }

        const confirmed = await ctx.ui.confirm("Release package?", `${formattedPlan}\n\nProceed?`);
        if (!confirmed) {
          if (preparedSnapshots) restoreFiles(preparedSnapshots);
          ctx.ui.notify("Release cancelled", "info");
          return;
        }

        const releaseResult = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const loader = new CancellableLoader(
            tui,
            (s: string) => theme.fg("accent", s),
            (s: string) => theme.fg("muted", s),
            "Starting release...",
          );
          loader.onAbort = () => done("cancelled");

          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
          container.addChild(loader);
          container.addChild(new Spacer(1));
          container.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
          container.addChild(new Spacer(1));
          container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

          executePlan(cwd, plan, (label) => loader.setMessage(label))
            .then(() => done("success"))
            .catch((err: unknown) => done(err instanceof Error ? err.message : String(err)));

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => loader.handleInput(data),
          };
        });

        if (releaseResult === "cancelled") {
          if (preparedSnapshots) restoreFiles(preparedSnapshots);
          ctx.ui.notify("Release cancelled", "info");
          return;
        }
        if (releaseResult !== "success") {
          ctx.ui.notify(releaseResult || "Release failed", "error");
          return;
        }

        ctx.ui.notify(`Created release ${plan.tag}. GitHub Actions will publish the npm package.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });
}
