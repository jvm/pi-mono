## Summary

- 

## Validation

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run pack:dry-run`
- [ ] `npm run security:audit`

## Security and privacy checklist

- [ ] No API keys, tokens, auth headers, local Pi settings, provider configs with secrets, or machine-specific paths are committed.
- [ ] New or changed network calls document what data leaves the local machine.
- [ ] New or changed config values avoid storing secrets in committed files.
- [ ] Logs, errors, fixtures, snapshots, and examples do not expose sensitive values.
- [ ] Package `files` entries include only intended runtime/docs assets.
- [ ] Security implications are documented in README/SECURITY/CHANGELOG when user-facing behavior changes.
