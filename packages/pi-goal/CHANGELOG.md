# Changelog

## 0.1.6 - 2026-06-06

### Changed

- Rename package from `@mocito/pi-goal` to `pi-goal` (unscoped).
- Aligned package structure with monorepo guidelines (added root `index.ts` re-export, `.editorconfig`, `.gitignore`; fixed extension entry point; removed non-canonical tsconfig flags).
- Update `author` field to full name for monorepo consistency.

## 0.1.3

- Move the extension entry point to `extensions/index.ts` so Pi displays the package extension compactly.

## 0.1.1

- Add best-effort install/update telemetry, gated by Pi telemetry/offline settings and disabled in CI.

## 0.1.0

- Initial `@mocito/pi-goal` package with `/goal`, goal tools, branch-scoped session persistence, usage accounting, UI status, and automatic continuation.
