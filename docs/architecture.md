# Architecture

DSH Open Deep Research is an open-source Deep Research agent and TypeScript framework for DeepSeek Harness. It owns the research method, domain contract, and reusable entry points; DeepSeek Harness continues to own the general Agent runtime, models, tools, Presets, sessions, subagents, policy, workspaces, and product surfaces.

## Package shape

The repository intentionally ships one package with seven Loader/import surfaces:

| Import                                            | Role                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `dsh-open-deep-research`                          | Public request/result/run types and `createResearchClient()` |
| `dsh-open-deep-research/service`                  | `ResearchEngine` Service Definition                          |
| `dsh-open-deep-research/provider`                 | Default adaptive DSH Agent Provider                          |
| `dsh-open-deep-research/tool`                     | `open_deep_research` model-facing consumer                   |
| `dsh-open-deep-research/app-startup`              | Dedicated Profile command-line parser                        |
| `dsh-open-deep-research/app-runner`               | One-shot consumer of the selected `ResearchEngine`           |
| `dsh-open-deep-research/jina-reader-prerequisite` | Runtime-key prerequisite for the explicit Jina Profile       |

The default bundle patch inserts only `./provider` and `./tool`, so installing it into stock Web or headless Profiles does not add a second application or Reader. Package-supplied search-only and Jina Reader overlays insert the two app subpaths only in a dedicated, base-only custom Profile; the Jina variant additionally mounts one DSH MCP Client and narrows its server-side roster to `read_url`. The abstract service is an import and replacement boundary, not a separately mounted plugin. Planner, research-unit, finding, and synthesis types stay package-private because no external implementation needs to version them independently.

## Domain contract

`ResearchEngine.start(request, execution?)` publishes a caller-owned `ResearchRun`. The serializable request contains:

- the question, optional purpose, and caller context;
- optional output format and language;
- optional `breadth`: `focused`, `balanced`, or `broad`.

Breadth is only a maximum fan-out of one, two, or three research units. It does not promise latency, token use, tool-call count, or answer depth, and the planner may keep a focused question to one unit at any breadth.

The canonical result contains a Markdown report, terminal status, normalized HTTP(S) links that appear in that report, timestamps, entry mode, and a Provider-defined implementation id. `metadata.mode` says whether the caller supplied a parent Agent; it does not expose the number of internal Agents. The default implementation id is `agent-adaptive`.

CLI and TypeScript callers may supply `purpose` and `context` directly. The model-facing `open_deep_research` Tool does not expose those fields. For a normal DSH Agent call, the Tool correlates the execution's root call id with the calling Agent's public Session event log and uses direct user text from the current turn as the research question. The root id keeps the same binding when Code Mode dispatches the Tool as a nested call beneath `run_code`. It falls back to the model-provided `question` only when no matching direct user message exists, such as a plugin-initiated dispatch without a recorded root call. This prevents model-authored background from entering the dedicated caller-context fields. It does not resolve an ambiguous reference to an earlier turn; the Tool description asks the parent Agent to clarify such a request before delegation.

After a completed or partial Tool run has been disposed successfully, the Tool defers one plugin-sourced instruction asking the parent Agent to return the rendered Markdown result verbatim. This keeps stock headless and Web surfaces on their ordinary assistant-message path while reducing a second summary or citation rewrite. The relay remains model-followed behavior rather than byte-level enforcement; callers that require the canonical report should consume the Tool value or `ResearchEngine` result directly.

## Adaptive research method

```text
resolved request
      |
      v
planning child --structured--> brief + 1..N non-overlapping units
      |
      v
research children (N <= breadth cap, bounded concurrency)
      |                    each uses ordinary DSH source tools
      +--structured--> compact findings + used URLs + limitations
      |
      v
synthesis child --structured--> final Markdown report
```

The Provider enforces breadth, concurrency, plan order, status mapping, and phase tool scope. The model chooses whether independent facets justify more than one unit; the planner is instructed to make the selected units collectively cover the dimensions requested by the user. An explicit request for papers, repositories, products, or another plural class is preserved as a need for multiple representative items rather than one item standing for the class. Research units prefer the primary source directly responsible for a claim when one is suitable, such as official documentation or repositories, original papers, regulatory publications, company filings, and original report pages. A central named entity is grounded in a matching official or original page before its identity or capabilities are used in comparisons and recommendations; a third-party extension establishes only its own behavior. Secondary sources remain useful for discovery, context, independent perspectives, and cross-checking.

When a useful URL is supplied, a unit with a Reader is instructed to read it before discovery search. Otherwise it searches for candidates, copies a returned URL instead of constructing an identifier from model memory, and reads the single highest-value page. The returned title and body must match the intended entity or claim; a mismatch is discarded and recorded as a limitation. Each page-reading call receives one URL string rather than an array; a second page is read only for a concrete gap or important cross-check. Short structured primary files such as package manifests are requested without a question filter so the Reader can return full content. Units never repeat an identical source call and normally stop after four total source calls. A fifth and final call is permitted only to read a canonical alternative already returned by a prior source tool after a high-priority primary read failed or mismatched. A truncated document with no continuation control is reported as a limitation rather than retried with the same arguments. Question-grounded excerpts may omit fields, so an absent field or phrase is not treated as proof that the original source lacks it; negative claims require complete content or another suitable primary source, otherwise they remain unresolved. Academic venue and publication status require a suitable original paper, proceedings, conference, or OpenReview source rather than an arXiv page or search snippet alone. These source-selection, evidence, and call-count rules are model-facing constraints, not a runtime scheduler. Planning and finding transfer use DSH's child-scoped `structured_output` runtime instead of parsing JSON from assistant prose.

Package-private finding sources carry `access: 'search-result' | 'page-read'`. A research unit is instructed to mark `page-read` only after a reading Tool returned the page body and `search-result` only when an actual search result exists. A failed read with neither snippet nor body is recorded in limitations with an empty structured source list. Synthesis and the deterministic fallback display the distinction. The schema validates the label but runtime does not independently correlate it with Tool history. This internal model-reported field does not change public `ResearchSource` or `ResearchResult.sources`.

The planner is instructed to preserve source and no-inference constraints without adding factual material or candidate entities that were absent from the request. Every research child receives the original request contract as well as its resolved unit; the brief and unit frame the task but are not returned source material and do not support factual claims by themselves. The synthesis child receives the original request, resolved brief, and compact findings in plan order, not raw session transcripts. Findings are explicitly marked as untrusted data so instructions embedded in retrieved pages do not become synthesis instructions. The writer is instructed to lead with the requested conclusions, merge overlapping unit findings, avoid repeated background and links, prefer primary and page-read support for key claims, preserve material uncertainty, and not introduce an external fact, URL, or citation absent from the request and usable findings. Source-supported facts are separated from analysis and recommendations; categorical absence, market-gap, maturity, or superiority claims from a limited scan are labeled as analysis of the observed sample. These remain model-facing semantic constraints rather than runtime hard enforcement.

An invalid or unsuccessful plan uses one whole-question unit and marks an otherwise successful run `partial`. One failed research unit does not cancel independent siblings. Synthesis still runs when at least one usable finding exists; if synthesis fails, the ordered findings become a visibly incomplete partial report that retains unit limitations and unavailable-unit errors. If every research unit fails, the run fails without invoking synthesis.

## DSH execution topology

```text
programmatic caller
  -> owned idle coordinator Agent
      -> planner, research units, synthesis as direct sibling children

open_deep_research Tool
  -> exact calling Agent
      -> planner, research units, synthesis as direct sibling children

dedicated research Profile app
  -> createResearchClient(ctx).start(request)
      -> same owned idle coordinator and adaptive method
```

For direct calls, the idle coordinator is a composition anchor. Before publication it resolves the configured working directory, resolves and records an optional Agent Preset, mounts that Preset, and installs the selected DSH model route. It never runs a conversation turn. Its children inherit that model, cwd, Preset generation, visible tools, and policy through ordinary DSH child composition.

For Tool calls, the exact calling Agent is the anchor. Every phase child therefore has `parentSession` equal to that Agent and `delegationDepth = parentDepth + 1`. The Provider never drives or mutates the caller's conversation.

The dedicated Profile app is another thin consumer, not another Agent layer. Its startup plugin maps the DSH launcher's immutable arguments to `ResearchRequest`; its runner invokes the deployment-selected service once with no parent. It therefore follows the same direct topology as any programmatic Client call and cannot bypass a replacement `ResearchEngine`.

All phases use the configured DSH Subagent backend. The default `spawn` backend is tested. The adaptive Provider requires `outputSchema`, `toolFilter`, and `persona` capabilities and rejects `start()` before run publication if the selected backend lacks any of them.

## Phase tool scope

- Planning receives `{ allow: [] }`; its only model-facing tool is the child-scoped `structured_output` capture tool.
- Research units receive `allowedTools`; omission defaults to `['web_search']`. The explicit Jina overlay replaces it with `['web_search', 'mcp__reader__read_url']`. This keeps shell, workflow, delegation, and unrelated MCP tools out of the research path. A deployment can explicitly replace the allow-list with literature, files, GitHub, or other source tools.
- Synthesis receives `{ allow: [] }` plus its child-scoped `structured_output` tool.

Web search, literature plugins, files, GitHub, MCP, and future sources remain ordinary DSH Tools selected by the host Profile or Preset. The Jina path is Profile composition over DSH MCP Client, not a new Source Service or a requirement of `ResearchEngine`.

DSH rc.8 models one `web_search` call as one to four queries. The normal four-call research-unit instruction and its single conditional recovery call count Tool calls rather than individual queries; the package does not rewrite or split host Tool input.

`ResearchResult.sources` currently means de-duplicated HTTP(S) links in the final report. It is not a source-quality score or a claim that all tools share one richer source record.

## Lifecycle

Provider capability checks and source-tool visibility checks happen before a run is accepted. The Provider then creates or selects the anchor and awaits publication of the planning child before returning `ResearchRun`. Planning model work continues through `run.result`; this preserves the boundary that composition and child-creation failures reject `start()`, while post-publication model failures become canonical results.

One fused signal owns planning, every research unit, and synthesis. `cancel()` aborts that signal. The method stops queued units, DSH cancels active children, and each `SubagentRun` is disposed after its result. A non-empty report already captured by synthesis is the terminal linearization point and is not erased by a racing late abort.

`dispose()` is idempotent. It cancels remaining work, drains pending/active phase runs, and releases the direct coordinator when one exists. The Provider tracks all public runs and performs the same drain when its Cordis fiber unloads.

The one-shot runner waits for the complete Loader tree before starting, then awaits both `run.result` and `run.dispose()` before writing a success payload. Its Cordis effect owns an upstream abort signal and the active run. When the DSH launcher disposes the tree—for example on `SIGINT`—the effect aborts, cancels, and drains the run while suppressing late output and `appExit`; the launcher's own exit code remains authoritative.

## Dedicated Profile app

An unknown Profile name initialized through `dsh plugin --profile research add ...` starts with `@deepseek-ai/dsh-base`, not the stock headless bundle. Installing this package adds its default Provider/Tool bundle layer. The Profile's user patch then inserts exactly one startup parser and one runner:

```text
@deepseek-ai/dsh-base
  + dsh-open-deep-research Provider/Tool bundle
  + one research Profile user patch:
      search-only: app-startup + app-runner
      Jina: MCP read_url + Provider allow-list + app-startup + app-runner
```

The package's initialization bin requires the Profile bundle list to contain exactly `@deepseek-ai/dsh-base` followed by this package, with no reordering, duplicates, or additional app layers. It copies one complete overlay only while the generated user patch has no configuration beyond the empty template, rejects a symbolic link or non-regular patch file, and writes through the already-checked file handle. It therefore neither merges non-empty user configuration nor introduces a second argument owner into another application Profile.

`--reader jina` is the explicit consent point for third-party URL processing. It requires a non-empty `JINA_API_KEY` before writing. The installed patch retains only a prerequisite subpath and service reference; it never materializes the value. At Loader startup the prerequisite trims the current environment value and publishes one runtime-only authorization service. The MCP and app-startup rows inject that service, so a missing key fails before connection or invocation publication. The Jina endpoint uses `include_tools=read_url&max_tokens=8000`; DSH's Provider allow-list independently ensures that research children see only `web_search` and the qualified Reader Tool.

The Jina path also requires outbound DNS, TCP, and TLS reachability to `mcp.jina.ai`; the package supplies neither a proxy nor an automatic Reader fallback. DSH MCP Client applies `toolCallTimeoutMs` to Tool calls, not startup, and does not expose one total connection/discovery deadline. The MCP SDK uses its 60-second default separately for initialize and each paginated `tools/list` request, so a complete discovery chain can take multiple intervals with little visible progress. Search-only remains independent of that endpoint. The 8,000-token Reader response can truncate long documents; complete arbitrary-length document coverage is not a current contract.

The default bundle and search-only overlay contain no MCP row and do not add an HTTP Fetch Provider. Existing non-empty Profile patches are not upgraded automatically.

Profile installation can print missing-peer warnings for Cordis and DSH host packages. The Profile workspace sets `autoInstallPeers: false`, while DSH exposes its CLI dependency closure through a shared installation-fallback directory; pnpm cannot count that runtime fallback as satisfying peers in the Profile manifest. The package keeps its real peer contract instead of installing a duplicate DSH runtime merely to silence the warning.

The app grammar exposes only serializable domain inputs: question, purpose, context, breadth, output format/language, and JSON presentation. Model, credentials, research tools, Preset, subagent backend, working directory, and policy remain DSH/Profile configuration. Jina credentials stay in the launching process environment and target URLs are processed by Jina only in the explicitly selected variant. Markdown mode keeps successful stdout report-only. For completed and partial outcomes, JSON mode serializes the existing canonical `ResearchResult` rather than defining a second result schema; failed and cancelled outcomes keep stdout empty and use stderr plus exit status.

## Provider configuration

| Field                      | Meaning                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `preset`                   | Existing DSH Agent Preset used by programmatic coordinator runs                   |
| `cwd`                      | Direct coordinator directory; relative paths resolve from the Harness process cwd |
| `provider`, `model`        | Optional model-route override                                                     |
| `maxTokens`                | Per-model-request output limit, not a total research budget                       |
| `allowedTools`             | Research-unit allow-list; defaults to `['web_search']`                            |
| `subagentProvider`         | Backend for all phases; defaults to capability-complete `spawn`                   |
| `maxParallelResearchUnits` | Maximum concurrent research units, from one to three; defaults to two             |

The four-call unit budget is model-facing. The package does not add a per-run tool-call or wall-clock scheduler, so it does not claim hard enforcement at the runtime layer.

## Why this is not a Workflow or a second runtime

The fixed research method is the vertical harness; DSH remains the execution kernel. A required host-plane Workflow Engine would not compose cleanly with the current DSH Web Preset isolation, while the public Subagent seam already provides the needed model, tool, lineage, cancellation, and structured-output behavior in headless and Web Profiles.

`ResearchEngine` remains the deliberate replacement boundary. Another implementation can use a literature-specific algorithm or a locally composed Workflow without changing the Client or Tool. The default package does not add Strategy, Source, Researcher, or Writer registries before a real independent consumer requires them.

## Verification paths

`pnpm check` runs formatting, lint, type checking, package build, and the offline suite. The suite covers:

- plan normalization, breadth caps, bounded concurrency, stable order, partial failure, fallback, and cancellation;
- real DSH planning, parallel source-tool use, synthesis tool isolation, and structured output;
- direct coordinator composition and delegated sibling lineage;
- caller cancellation, Provider unload, and complete Agent cleanup;
- command-line mapping, output/exit behavior, failed cleanup, search-only/Jina initialization, and secret-free overlay generation;
- search-then-read and known-URL direct-read research children, source access labels, and Reader Tool isolation;
- direct-user question binding for model-facing Tool calls, with a fallback for calls that have no matching human Session event;
- a real Cordis Loader importing built package subpaths and executing Client, Tool, and one-shot app paths.

The Alpha.5 candidate also completed clean search-only and Jina Profile composition with published DSH rc.8. A credential-backed Jina run then completed one search, two successful page reads, and a cited report through the packaged runtime.

Release changes are summarized in [Changelog](../CHANGELOG.md).
