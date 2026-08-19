# 🔬 DSH Open Deep Research

[简体中文](./README.zh-CN.md)

DSH Open Deep Research is a configurable Deep Research agent and TypeScript framework built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It turns a research question into a cited Markdown report and exposes the same research service through a CLI, a DSH Tool, and a programmatic API.

> **Project status:** `0.1.0-alpha.4` Public Preview. The package is tested with published DSH `0.1.0-rc.7`, distributed through GitHub Releases, and not published to npm.

## What it does

- Plans one to three focused research units, runs them through DSH child Agents, and synthesizes their findings.
- Supports Web search in both dedicated Profiles and selected page or PDF reading in `research-jina`.
- Returns a cited Markdown report, normalized links, terminal status, and run metadata.
- Provides CLI, DSH Tool, and TypeScript entry points over a replaceable `ResearchEngine`.

## 🏗️ Architecture

```mermaid
flowchart TD
  USER["User or application"] --> ENTRY{"Entry"}

  ENTRY --> CLI["Dedicated research CLI"]
  ENTRY --> TOOL["open_deep_research Tool"]
  ENTRY --> API["createResearchClient()"]

  CLI --> ENGINE["ResearchEngine"]
  TOOL --> ENGINE
  API --> ENGINE

  ENGINE --> PLAN["Planning Agent<br/>brief and 1 to 3 units"]
  PLAN --> RESEARCH["Research Agents<br/>bounded concurrent work"]
  RESEARCH --> SYNTHESIS["Synthesis Agent<br/>final cited report"]
  SYNTHESIS --> RESULT["Markdown report<br/>ResearchResult"]

  RESEARCH --> SEARCH["DSH web_search"]
  RESEARCH -. "research-jina only" .-> JINA["Jina read_url through MCP"]

  DSH["DeepSeek Harness<br/>models, Tools, Presets, sessions, child Agents, cancellation"]
  DSH -. "runs and manages" .-> PLAN
  DSH -. "runs and manages" .-> RESEARCH
  DSH -. "runs and manages" .-> SYNTHESIS
```

All entry points call the same `ResearchEngine`. The active Profile selects the source Tools available to Research Agents. See [Architecture](./docs/architecture.md) for lifecycle, Profile composition, configuration, and result semantics.

## 🚀 Quickstart

Download the prerelease package from GitHub. Contributors who want to build from source can follow [Contributing](./CONTRIBUTING.md).

| Profile         | Source capabilities         | Credentials               | Network requirement            |
| --------------- | --------------------------- | ------------------------- | ------------------------------ |
| `research-jina` | Search and page/PDF reading | DeepSeek Key and Jina Key | DeepSeek API and `mcp.jina.ai` |
| `research`      | Search only                 | DeepSeek Key              | DeepSeek API                   |

Requirements: Node.js `^22.19.0` or `>=24.0.0`, pnpm `10.x` available on `PATH`, and DeepSeek Harness `0.1.0-rc.7`.

DSH calls the `pnpm` executable when it manages Profile plugins, so `npx` alone is not sufficient. Check both commands before installation:

```bash
node --version
pnpm --version
```

See the [pnpm installation guide](https://pnpm.io/installation) if the second command is unavailable.

### 1. Download the package

```bash
curl -fL -O \
  https://github.com/songyang0603/dsh-open-deep-research/releases/download/v0.1.0-alpha.4/dsh-open-deep-research-0.1.0-alpha.4.tgz
```

This downloads `dsh-open-deep-research-0.1.0-alpha.4.tgz` into the current directory.

### 2. Full Research: search and read sources (recommended)

`research-jina` provides Web search and page reading. It sends selected public URLs to Jina without browser cookies. Use public, non-sensitive URLs and avoid signed, authenticated-session, private-network, or internal URLs.

Set both keys and check that the deployment network can reach Jina:

```bash
export DEEPSEEK_API_KEY='<your-deepseek-key>'
export JINA_API_KEY='<your-jina-key>'

curl --connect-timeout 10 --max-time 20 -I \
  'https://mcp.jina.ai/v1?include_tools=read_url&max_tokens=8000'
```

Any HTTP response confirms that DNS, TCP, and TLS reached the endpoint. `HEAD` currently returns `405 Method Not Allowed`. This check does not validate the key or complete MCP startup. Use the search-only Profile below if the endpoint does not respond.

DSH rc.7 can print missing host peer warnings during `plugin add`. If the command exits with code `0`, continue with the initializer.

```bash
npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile research-jina add \
  ./dsh-open-deep-research-0.1.0-alpha.4.tgz

npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile research-jina exec \
  dsh-open-deep-research-init --reader jina

npx @deepseek-ai/dsh@0.1.0-rc.7 --profile research-jina \
  --breadth balanced \
  --language English \
  "Research the main changes in DeepSeek Harness rc.7. Search for relevant material, read important source pages, and produce a report with citation links."
```

Research Agents choose which source Tools to call. The Profile provides both Tools without requiring a fixed number of calls. The Reader response limit is 8,000 tokens, so long documents can be truncated.

### 3. Search-only: DeepSeek Key only

Use the independent `research` Profile when a Jina Key or network path is unavailable. It keeps planning, Web search, multiple research units, synthesis, and report generation. It does not provide reliable access to full page or PDF bodies.

The same rc.7 host peer warnings can appear during `plugin add`. If the command exits with code `0`, continue with the initializer.

```bash
export DEEPSEEK_API_KEY='<your-deepseek-key>'

npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile research add \
  ./dsh-open-deep-research-0.1.0-alpha.4.tgz

npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile research exec \
  dsh-open-deep-research-init

npx @deepseek-ai/dsh@0.1.0-rc.7 --profile research \
  --language English \
  "Research the main changes in DeepSeek Harness rc.7 and produce a report."
```

### 4. Save the output

Markdown mode writes the report to stdout, so it can be redirected to a file:

```bash
npx @deepseek-ai/dsh@0.1.0-rc.7 --profile research-jina \
  "Compare two research approaches" > report.md
```

The first clean `npx @deepseek-ai/dsh` invocation can spend several minutes downloading and building dependencies with little output. Wait for it to exit before retrying. The two Profiles are independent and never overwrite or automatically downgrade into each other.

## ⚙️ Configuration

| Option       | Values                                                   | Default           |
| ------------ | -------------------------------------------------------- | ----------------- |
| `--purpose`  | Free text                                                | omitted           |
| `--context`  | Free text                                                | omitted           |
| `--breadth`  | `focused`, `balanced`, `broad`                           | `balanced`        |
| `--format`   | `report`, `brief`, `memo`                                | `report`          |
| `--language` | Language name or locale                                  | question language |
| `--json`     | Canonical `ResearchResult` for completed or partial runs | off               |

Breadth sets the maximum number of research units to one, two, or three. Planning can choose fewer. Provider settings such as model route, Preset, working directory, source Tool allow-list, and maximum research concurrency are documented in [Architecture](./docs/architecture.md#provider-configuration).

Completed and partial runs exit with code `0`; a partial run also writes a concise notice to stderr. Execution failures use `1`, argument errors use `2`, and user interruption uses `130`. Failed or cancelled runs leave stdout empty.

## Use from DSH and TypeScript

Install the same tarball into stock DSH Profiles to expose `open_deep_research` as a Tool:

```bash
npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile headless add \
  ./dsh-open-deep-research-0.1.0-alpha.4.tgz

npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile web add \
  ./dsh-open-deep-research-0.1.0-alpha.4.tgz
```

Stock `headless` and `web` receive the Provider and Tool only. Their configured `allowedTools` determines source capabilities.

The TypeScript API calls the selected `ResearchEngine` directly:

```ts
import { createResearchClient } from 'dsh-open-deep-research'

const result = await createResearchClient(ctx).run({
  question: 'How are Agent Presets composed in DeepSeek Harness?',
  purpose: 'Prepare an architecture note for plugin authors.',
  breadth: 'balanced',
  output: { format: 'report', language: 'English' },
})

console.log(result.status)
console.log(result.report)
```

Use `createResearchClient(ctx).start()` for a cancellable `ResearchRun`. See the [domain contract](./docs/architecture.md#domain-contract) for the full API behavior.

## Compatibility and current limits

| Area                     | Current status                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| DSH `0.1.0-rc.7`         | Full offline suite, clean Profile composition, and a packaged live `research-jina` run completed.                 |
| Jina Reader              | Live search, page reading, and cited-report generation completed. Availability depends on the deployment network. |
| Documents and Tool calls | Short pages and short PDFs are tested. Long inputs can be truncated. Source-call limits are prompt instructions.  |
| `ResearchResult.sources` | De-duplicated HTTP links from the final report. A link alone does not confirm page reading or source quality.     |
| MCP startup              | An unresponsive route can take multiple SDK timeout intervals. `plugin add` can also print host peer warnings.    |

Project documents: [Architecture](./docs/architecture.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

## License

[MIT](./LICENSE)
