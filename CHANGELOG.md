# Changelog

All notable changes to this project are documented here.

## [Unreleased]

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
