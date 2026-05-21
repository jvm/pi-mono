# Security Policy

## Supported versions

Security fixes are provided for the latest released version of each package in this monorepo.

## Reporting a vulnerability

Please do **not** open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected package versions or commits, if known;
- impact and any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security checks

The monorepo runs security checks in GitHub Actions:

- TruffleHog secret scanning;
- Semgrep static analysis for JavaScript/TypeScript/Node.js;
- CodeQL analysis;
- zizmor auditing for GitHub Actions workflows;
- OpenSSF Scorecard supply-chain posture checks;
- pinned GitHub Actions SHAs with version comments for Dependabot visibility;
- `npm audit --omit=dev` for production dependency advisories;
- Dependabot updates for npm and GitHub Actions.

Before opening or merging security-sensitive changes, run the normal validation locally:

```bash
npm run validate
```

Never commit API keys, tokens, auth headers, local Pi settings, provider configuration containing secrets, or machine-specific paths.
