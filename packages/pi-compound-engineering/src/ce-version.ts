/**
 * The Compound Engineering (CE) version this package mirrors.
 *
 * `CE_VERSION` identifies the pinned upstream `compound-engineering`
 * component release. `PACKAGE_VERSION` identifies this npm package. They
 * normally match; a Pi-specific hotfix may increment the package patch while
 * retaining the same pinned upstream CE release.
 *
 * `scripts/stage.mjs` reads the upstream `ceVersion` from `package.json`,
 * while this file is the extension API and verification contract.
 */
export const PACKAGE_VERSION = "3.19.1";
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
