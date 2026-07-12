/**
 * The Compound Engineering (CE) version this package mirrors.
 *
 * The package version is **identical** to the upstream CE `compound-engineering`
 * component version, as recorded in CE's
 * `.github/.release-please-manifest.json` (the root-native `compound-engineering` component).
 * Users reading the upstream changelog or release notes can match the version
 * they have installed with a one-to-one mapping.
 *
 * Both `scripts/stage.mjs` and `scripts/commit.mjs` read `CE_VERSION` from
 * `package.json` (not from this file) to avoid a dual source of truth at
 * install time. This file is the API surface for the extension and the
 * structure check.
 */
export const CE_VERSION = "3.19.0";

/**
 * Expected counts after conversion for the pinned CE version.
 *
 * The structure check (`scripts/verify.mjs`) asserts these match the
 * upstream tarball. A new CE release that changes the skill inventory must
 * bump this constant in lockstep with `CE_VERSION`.
 *
 * Upstream v3.19.0 is a root-native, skills-only plugin. Its 29 skills
 * are available on Pi; former standalone agents now live as skill-local
 * prompt assets and are intentionally not registered as Pi subagents.
 */
export const EXPECTED_SKILL_COUNT = 29;

/**
 * The upstream CE release tag for the pinned CE version.
 * v3.14.0+ uses the `compound-engineering-v` prefix. The former `cli-v`
 * alias stopped receiving releases after v3.13.1.
 */
export function getCeReleaseTag(version: string = CE_VERSION): string {
	return `compound-engineering-v${version}`;
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
