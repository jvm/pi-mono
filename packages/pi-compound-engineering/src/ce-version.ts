/**
 * The Compound Engineering (CE) version this package mirrors.
 *
 * The package version is **identical** to the upstream CE `compound-engineering`
 * component version, as recorded in CE's
 * `.github/.release-please-manifest.json` (`plugins/compound-engineering`).
 * Users reading the upstream changelog or release notes can match the version
 * they have installed with a one-to-one mapping.
 *
 * Both `scripts/stage.mjs` and `scripts/commit.mjs` read `CE_VERSION` from
 * `package.json` (not from this file) to avoid a dual source of truth at
 * install time. This file is the API surface for the extension and the
 * structure check.
 */
export const CE_VERSION = "3.13.1";

/**
 * Expected counts after conversion for the pinned CE version.
 *
 * The structure check (`scripts/verify.mjs`) asserts these match the
 * upstream tarball. A new CE release that adds or removes skills/agents
 * must bump these constants in lockstep with `CE_VERSION`.
 *
 * Note: the upstream tarball ships 39 skills, but `ce-update` is gated
 * to `ce_platforms: [claude]` only (it depends on the Claude Code
 * plugin-harness cache layout) and is excluded by the converter's
 * platform filter. 38 skills land in the Pi install dir.
 */
export const EXPECTED_SKILL_COUNT = 38;
export const EXPECTED_AGENT_COUNT = 43;

/**
 * The upstream CE release tag for the pinned CE version.
 * `cli-v` is the prefix the Every maintainers use; see
 * https://github.com/EveryInc/compound-engineering-plugin/releases.
 */
export function getCeReleaseTag(version: string = CE_VERSION): string {
	return `cli-v${version}`;
}

/**
 * The codeload tarball URL for the pinned CE version.
 */
export function getCeTarballUrl(version: string = CE_VERSION): string {
	return `https://codeload.github.com/EveryInc/compound-engineering-plugin/tar.gz/refs/tags/${getCeReleaseTag(version)}`;
}

/**
 * The upstream repo URL for the pinned CE version.
 */
export function getCeRepoUrl(version: string = CE_VERSION): string {
	return `https://github.com/EveryInc/compound-engineering-plugin/tree/${getCeReleaseTag(version)}`;
}

/**
 * Return the pinned CE version. Equivalent to reading `CE_VERSION` directly
 * but kept as a function for symmetry with `getCeReleaseTag` / `getCeTarballUrl`
 * and to allow a future override (e.g. environment variable, settings.json).
 */
export function getCeVersion(): string {
	return CE_VERSION;
}
