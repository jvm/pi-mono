# Contributing

Use the repository's npm workspace environment.

```bash
npm run -w packages/pi-openai-reasoning check
npm test -w packages/pi-openai-reasoning
npm run -w packages/pi-openai-reasoning pack:dry-run
```

Keep model eligibility conservative. Backend protocol changes need real Pi
integration regressions and the documented opt-in smoke test. Normal tests must
not contact providers. Do not commit credentials, sessions or machine paths.
Update README, CHANGELOG and SECURITY when their documented behavior changes.

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
