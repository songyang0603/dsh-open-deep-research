# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.1.0-alpha.5] - 2026-08-20

### Changed

- Aligned the host, development dependencies, and Profile examples with DeepSeek Harness `0.1.0-rc.8`.
- Bound ordinary `open_deep_research` Tool calls to direct user text from the current DSH turn and removed model-facing `purpose` and `context` fields.
- Updated the default method to ground central entities in matching official sources, avoid guessed source identifiers and mismatched pages, preserve plural-source coverage, apply stronger publication-status evidence rules, recover once from a failed high-priority read, distinguish sourced facts from analysis, and reduce repeated conclusions and links during synthesis.
- Added a plugin-sourced relay instruction asking stock DSH Agents to preserve completed and partial Markdown reports and inline links, reducing parent-model rewrite risk while retaining the ordinary assistant-response path.
- Prevented adjacent Markdown and CJK prose punctuation from being encoded into bare URLs in `ResearchResult.sources`.
- Validated the offline suite, clean Profile composition, and a packaged rc.8 Full Research run with search, page reading, and a cited report.

## [0.1.0-alpha.4] - 2026-08-18

Initial Public Preview.

### Added

- Added an adaptive Deep Research method with structured planning, one to three research units, bounded concurrency, and isolated final synthesis.
- Added dedicated `research` and `research-jina` Profiles for search-only and search-plus-page-reading runs.
- Added a one-shot CLI, the `open_deep_research` DSH Tool, and a TypeScript Client over the same `ResearchEngine` contract.
- Added Markdown and JSON output, cancellation, partial-result handling, source links, and lifecycle cleanup.
- Added optional Jina page and PDF reading through DSH MCP Client.

### Changed

- Set the supported DeepSeek Harness host and development line to `0.1.0-rc.7`.
- Made `research-jina` the recommended Quickstart while keeping an independent search-only path.

### Security

- Keeps Jina credentials in runtime memory rather than generated Profile files.
- Keeps Jina and MCP Reader rows out of the default bundle and search-only Profile.
- Requires explicit selection before public URLs are sent to the Jina Reader.
