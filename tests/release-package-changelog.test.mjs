import assert from "node:assert/strict";
import test from "node:test";
import { prepareChangelogRelease } from "../.pi/extensions/release-package/changelog.ts";

for (const [label, unreleased, release] of [
  ["bracketed", "## [Unreleased]", "## [1.2.3] - 2026-07-17"],
  ["plain", "## Unreleased", "## 1.2.3 - 2026-07-17"],
]) {
  test(`prepares ${label} changelog without moving pending entries`, () => {
    const current = `# Changelog\n\nIntro.\n\n${unreleased}\n\n### Fixed\n\n- Important fix.\n`;
    const next = prepareChangelogRelease(current, "1.2.3", "2026-07-17");

    assert.equal(next, `# Changelog\n\nIntro.\n\n${unreleased}\n\n${release}\n\n### Fixed\n\n- Important fix.\n`);
  });
}

test("does not duplicate an existing release heading", () => {
  const current = "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-07-17\n";
  assert.equal(prepareChangelogRelease(current, "1.2.3", "2026-07-18"), current);
});
