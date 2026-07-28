# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-skillful`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-skillful` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

### Progressive skill loading and trust boundary

`pi-skillful` extends Pi's skill discovery to ancestor directories above the git repository root, loading `.agents/skills/` from every parent directory up to the filesystem root (excluding `~/.agents/skills/`, which Pi already loads globally).

This means skills placed in a shared or writable ancestor directory — for example, `/home/shared/.agents/skills/` or `/tmp/.agents/skills/` — are automatically available as skill instructions when Pi runs in any nested repository. Review the contents and ownership of `.agents/skills/` directories above your repositories, as they are now part of the effective skill set.

To disable progressive loading without removing the package, uninstall `pi-skillful` or use Pi's built-in `--no-skills` flag to suppress all skill loading for a session.
