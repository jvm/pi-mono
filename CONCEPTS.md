# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Pi packages

### Pi package
An installable bundle that contributes Pi resources such as extensions, skills, prompt templates, or themes to a user's Pi environment.

### Recipe-only package
A Pi package whose committed source describes how to fetch, verify, convert, or stage runtime resources rather than committing the generated resources themselves.

### Package extension
The runtime code a Pi package loads to register commands, tools, hooks, or system-prompt context for Pi sessions.

### Generated skill
A skill produced during package install from another source of truth, rather than a skill whose final installed content is committed directly in this repository.

### Skill-local resource
A script, reference file, or asset that belongs to a specific skill and should be resolved relative to that skill's directory.

## Compound Engineering

### Compound Engineering skill
A skill from the Compound Engineering workflow suite, exposed in Pi with a `ce-*` name and used for planning, work execution, review, documentation, or related engineering workflows.

### Runtime guidance
Package-provided context injected while Pi is preparing an agent turn so the model can interpret installed resources or workflow constraints that are not obvious from the user's project files alone.
