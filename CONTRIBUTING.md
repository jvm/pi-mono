# Contributing

## Development

Run the root validation loop before opening a pull request unless the change is documentation-only:

```bash
npm install
npm run validate
```

Package-specific smoke tests and release checks are documented in each package's README and `AGENTS.md`.

## Pull requests

Keep pull requests focused and include:

- a concise summary of the change;
- validation commands run;
- package-specific smoke-test notes when behavior changes;
- security/privacy notes for config, provider, network, auth, logging, or packaging changes.

## Security checklist

- Do not commit API keys, tokens, auth headers, local Pi settings, provider configuration containing secrets, or machine-specific paths.
- Keep package `files` arrays explicit and review `npm pack --dry-run` output before release.
- Document any new external data flow, telemetry, cache behavior, or local file access.
- Redact secrets from logs, test fixtures, snapshots, examples, and error output.
- Prefer least-privilege GitHub Actions permissions and set `persist-credentials: false` on checkout unless a job must push.

## Vulnerabilities

Please do not report vulnerabilities in public issues. See [SECURITY.md](./SECURITY.md).
