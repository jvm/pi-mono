export function prepareChangelogRelease(changelog: string, version: string, date: string): string {
  const hasVersion = changelog
    .split("\n")
    .some((line) => line.startsWith(`## ${version} - `) || line.startsWith(`## [${version}] - `));
  if (hasVersion) return changelog;

  const unreleasedHeading = /^## (\[Unreleased\]|Unreleased)$/m;
  const match = changelog.match(unreleasedHeading);
  if (match) {
    const bracketed = match[1].startsWith("[");
    const release = bracketed ? `## [${version}] - ${date}` : `## ${version} - ${date}`;
    return changelog.replace(unreleasedHeading, `${match[0]}\n\n${release}`);
  }

  return changelog.replace("# Changelog\n", `# Changelog\n\n## ${version} - ${date}\n`);
}
