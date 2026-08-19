# Contributing

Thank you for helping improve DSH Open Deep Research. This guide applies to this repository only.

## Project phase

The repository is public and project-scoped issues and pull requests are welcome. The package has not been published to npm. Removing `"private": true`, publishing a GitHub or npm release, and changing release automation remain separate maintainer decisions; a contribution does not authorize them.

## What belongs here

Good contribution areas include:

- the Deep Research method, request/result contract, Client, Provider, Tool, or one-shot app;
- DSH Profile composition and compatibility;
- search-only or explicitly selected page-reading behavior;
- lifecycle, cancellation, source handling, tests, examples, and documentation.

Changes to DeepSeek Harness itself do not belong in this repository. Report an upstream limitation here only when it has a concrete impact on this package or when proposing a package-level compatibility fix or workaround.

Before opening an issue, search for an existing report. Include:

- the package and DSH versions;
- the Profile and operating system;
- minimal reproduction steps;
- expected and actual behavior;
- sanitized logs or configuration when relevant.

## Development setup

Use Node.js `^22.19.0 || >=24.0.0` and pnpm `10.19.0`.

```bash
pnpm install --frozen-lockfile
pnpm check
```

For focused iteration, a single test file may be run first:

```bash
pnpm test -- tests/method.spec.ts
```

Run `pnpm check` before marking a change ready. It performs formatting, lint, type checking, build, and the offline test suite.

Run `pnpm pack` as an additional check when changing package exports, bundle/Profile files, the initializer, or published documentation. Do not commit generated `dist/` files or tarballs.

## DSH compatibility

`package.json` and the README status block are the current authority for supported DSH versions.

Do not silently upgrade DSH dependency pins or broaden compatibility claims. A compatibility change should state the exact DSH version or source commit, the commands and runtime paths actually tested, and any unverified live boundary.

## Pull requests

Keep each pull request focused on one decision or defect.

A ready pull request should:

- explain the problem independently of the chosen implementation;
- link the relevant issue when applicable;
- update tests, current-state documentation, examples, and public types together when their facts change;
- exercise the real DSH composition path when user- or model-visible behavior changes;
- report commands actually run and clearly identify checks or live paths not run;
- avoid unrelated refactoring or changes to upstream DeepSeek Harness source.

## Documentation style

Write README and user documentation for a first-time reader:

- state behavior, defaults, and limits directly;
- keep the recommended capability path before lower-requirement alternatives;
- use short paragraphs, tables, and copyable commands where they improve scanning;
- keep implementation details in `docs/architecture.md` when they help users or contributors understand the current system;
- avoid marketing claims, em dashes, contrast formulas such as “not X but Y,” and internal terminology that does not help the user complete a task;
- use emoji only on a small number of major headings.

English and Chinese READMEs should keep the same section order, commands, version statements, and compatibility limits. Write each language naturally rather than translating sentence by sentence.

## Secrets and live testing

The default test suite must remain keyless and independent of external services. Use unmistakably fake fixture values in tests.

Keep credentials outside the repository. Do not commit `.env`, `.dsh`, `.direnv`, credential files, logs, session artifacts, or command output containing secrets.

Live DeepSeek or Jina checks are optional, explicit, and separate from `pnpm check`. Contributors use only their own credentials and must not require reviewers to provide keys. Jina tests may send target URLs to a third party; use only public, non-sensitive URLs and never private, signed, authenticated-session, or internal-network resources.

When reporting a live result, record the environment, DSH version, Profile, path exercised, and sanitized outcome. A keyless composition check, a live search-only run, and a live Jina run are distinct results and must not be presented as equivalent.
