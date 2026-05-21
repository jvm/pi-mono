import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["pi-codex-image-gen", "pi-scout", "pi-skillful", "pi-web-kit"] as const;
type PackageName = (typeof PACKAGES)[number];

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseArgs(args: string): { packageName: PackageName; version: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("Usage: /release-package <package> <version>");
  }

  const [packageName, version] = parts;
  if (!PACKAGES.includes(packageName as PackageName)) {
    throw new Error(`Unknown package: ${packageName}. Expected one of: ${PACKAGES.join(", ")}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return { packageName: packageName as PackageName, version };
}

async function run(command: string, cwd: string): Promise<CommandResult> {
  console.log(`\n$ ${command}`);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command}`));
      }
    });
  });
}

async function runQuiet(command: string, cwd: string): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
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

async function buildPlan(cwd: string, packageName: PackageName, version: string): Promise<ReleasePlan> {
  const packageDir = `packages/${packageName}`;
  const packageJsonPath = join(cwd, packageDir, "package.json");
  const changelogPath = join(cwd, packageDir, "CHANGELOG.md");
  const tag = `${packageName}@${version}`;

  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing package.json: ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
  if (packageJson.name !== packageName) {
    throw new Error(`Package name mismatch in ${packageJsonPath}: expected ${packageName}, got ${packageJson.name}`);
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

async function executePlan(cwd: string, plan: ReleasePlan): Promise<void> {
  await run(`npm run check --workspace ${plan.packageDir}`, cwd);
  await run(`npm test --workspace ${plan.packageDir} --if-present`, cwd);
  await run(`npm run pack:dry-run --workspace ${plan.packageDir}`, cwd);
  await run("npm audit --omit=dev", cwd);
  await run("git status --short", cwd);

  if (plan.hasChanges) {
    await run(`git add ${plan.packageDir} package.json package-lock.json`, cwd);
    await run(`git commit -m ${shellQuote(`Release ${plan.packageName} ${plan.version}`)}`, cwd);
  }

  await run(`git tag ${shellQuote(plan.tag)}`, cwd);
  await run(`git push origin main ${shellQuote(plan.tag)}`, cwd);
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
      const [first = "", second = ""] = prefix.split(/\s+/, 2);
      if (prefix.includes(" ")) {
        const packageName = first as PackageName;
        if (!PACKAGES.includes(packageName)) return null;
        try {
          const packageJson = JSON.parse(
            readFileSync(join(process.cwd(), "packages", packageName, "package.json"), "utf8"),
          ) as { version?: string };
          if (packageJson.version?.startsWith(second)) {
            return [{ value: `${packageName} ${packageJson.version}`, label: packageJson.version }];
          }
        } catch {
          return null;
        }
        return null;
      }

      const items = PACKAGES.filter((name) => name.startsWith(first)).map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        const cwd = process.cwd();
        const { packageName, version } = parseArgs(args);
        const plan = await buildPlan(cwd, packageName, version);
        const formattedPlan = formatPlan(plan);

        console.log(`\n${formattedPlan}\n`);
        const confirmed = await ctx.ui.confirm("Release package?", `${formattedPlan}\n\nProceed?`);
        if (!confirmed) {
          ctx.ui.notify("Release cancelled", "info");
          return;
        }

        await executePlan(cwd, plan);
        ctx.ui.notify(`Created release ${plan.tag}. GitHub Actions will publish the npm package.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        console.error(message);
      }
    },
  });
}
