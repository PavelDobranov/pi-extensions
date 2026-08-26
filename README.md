# pi-extensions

A public pnpm monorepo for independent Pi extensions.

## Extensions

This catalog is maintained by hand. Add each extension here with a short
description and a link to its package directory.

- [`pi-statusline`](extensions/pi-statusline) — theme-aware status line footer
  for Pi.

## Installation

Pi packages are private by default while they are being developed. After an
extension is published, install it with Pi's native package commands.

### Global installation

```bash
pi install npm:@pdobranov/<extension-name>
```

### Project installation

Install an extension into the current project's Pi configuration:

```bash
pi install -l npm:@pdobranov/<extension-name>
```

For local development, Pi can also install an extension package from a
filesystem path:

```bash
pi install /path/to/pi-extensions/extensions/<extension-name>
```

## Publishing

Extension packages are private by default while they are being developed.

When an extension is ready to publish, the same package graduates in place:

- set a semantic `version`, such as `1.0.0`
- set `"private": false`
- add a `files` allowlist
- add `publishConfig.access = "public"`
- add repository, license, and other publication metadata

Publishing is manual in v1. Tags are package-specific, for example
`pi-prewalk@1.0.0`; there is no repo-wide release version.

## Public repository safety

This repository is public. Anything committed here must be safe to expose
publicly.

Do not commit secrets, credentials, company-confidential logic, internal URLs or
configuration, machine-specific state, or project-specific local state.
Package-owned assets, prompts, templates, examples, and default configuration
are fine when they are safe for a public repository.

Run the lightweight public-safety helper before committing:

```bash
pnpm check:public
```
