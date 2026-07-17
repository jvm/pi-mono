export function prepareChangelogRelease(changelog: string, version: string, date: string): string {
  const versionHeading = new RegExp(`^## \\[?${escapeRegExp(version)}\\]? - `, "m");
  if (versionHeading.test(changelog)) return changelog;

  const unreleasedHeading = /^## (\[Unreleased\]|Unreleased)$/m;
  const match = changelog.match(unreleasedHeading);
  if (match) {
    const bracketed = match[1].startsWith("[");
    const release = bracketed ? `## [${version}] - ${date}` : `## ${version} - ${date}`;
    return changelog.replace(unreleasedHeading, `${match[0]}\n\n${release}`);
  }

  return changelog.replace("# Changelog\n", `# Changelog\n\n## ${version} - ${date}\n`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
