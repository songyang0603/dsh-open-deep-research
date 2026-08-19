import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  installModelSelection,
  type Agent,
  type AgentOptions,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { DshResearchMethodDriver } from './dsh-method-driver.js'
import { executeResearchMethod, maxUnitsForRequest } from './method.js'
import { failedResult, materializeResult } from './result.js'
import { ManagedResearchRun } from './run.js'
import ResearchEngine from './service.js'
import type { ResearchRequest, ResearchResult, ResearchRun, ResearchStartContext } from './types.js'

/** Model-facing consumer name registered by this package. */
export const RESEARCH_TOOL_NAME = 'open_deep_research'

/** Default provider deployment configuration. */
export interface Config {
  /** Existing DSH Agent Preset used by direct programmatic calls. */
  readonly preset?: string
  /** Working directory used by direct programmatic calls. */
  readonly cwd?: string
  /** Optional model-route override. Omitted fields inherit DSH defaults or the parent Agent. */
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  /** Tools available to research units. Omission defaults to web_search. */
  readonly allowedTools?: string[]
  /** DSH subagent provider used for planning, research units, and synthesis. */
  readonly subagentProvider?: string
  /** Maximum research units executing at the same time. */
  readonly maxParallelResearchUnits?: number
}

interface ResolvedConfig extends Config {
  readonly cwd: string
  readonly allowedTools: string[]
  readonly subagentProvider: string
  readonly maxParallelResearchUnits: number
}

interface AgentPresetRuntime {
  resolve(id?: string): Promise<{ id: string }>
  mount(ctx: Context, id: string): Promise<void>
}

function fuseSignal(controller: AbortController, upstream?: AbortSignal): AbortSignal {
  return upstream === undefined ? controller.signal : AbortSignal.any([controller.signal, upstream])
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('research run cancelled')
}

function cleanupFailure(failures: unknown[], message: string): never {
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, message)
}

async function disposeAll(
  disposals: readonly (() => Promise<void>)[],
  message: string,
): Promise<void> {
  const outcomes = await Promise.allSettled(
    disposals.map((dispose) => Promise.resolve().then(dispose)),
  )
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map((outcome) => outcome.reason)
  if (failures.length > 0) cleanupFailure(failures, message)
}

async function disposeDirectResources(
  driver: DshResearchMethodDriver,
  handle: { dispose(): Promise<void> },
): Promise<void> {
  const failures: unknown[] = []
  try {
    await driver.dispose()
  } catch (error) {
    failures.push(error)
  }
  try {
    await handle.dispose()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) cleanupFailure(failures, 'failed to dispose Deep Research resources')
}

async function failAfterDirectCleanup(
  primary: unknown,
  driver: DshResearchMethodDriver,
  handle: { dispose(): Promise<void> },
): Promise<never> {
  try {
    await disposeDirectResources(driver, handle)
  } catch (cleanupError) {
    throw new AggregateError(
      [primary, cleanupError],
      'Deep Research start failed and its pre-publication resources did not cleanly dispose',
    )
  }
  throw primary
}

function resolveWorkingDirectory(configured?: string): string {
  const cwd = resolve(configured ?? process.cwd())
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('path is not a directory')
    accessSync(cwd, constants.R_OK | constants.X_OK)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`research cwd is not an accessible directory: ${cwd} (${detail})`)
  }
  return cwd
}

/** DSH Agent/Subagent-backed adaptive implementation of the research seam. */
export class AgentResearchEngine extends ResearchEngine {
  static inject = ['agentDefaultModel', 'agents', 'subagents', 'systemPrompt', 'tools']

  static Config: z<Config> = z.object({
    preset: z.string(),
    cwd: z.string(),
    provider: z.string(),
    model: z.string(),
    maxTokens: z.natural().min(1),
    allowedTools: z.array(z.string()).default(['web_search']),
    subagentProvider: z.string().default('spawn'),
    maxParallelResearchUnits: z.natural().min(1).max(3).default(2),
  })

  private readonly config: ResolvedConfig
  private readonly active = new Set<ManagedResearchRun>()
  private accepting = true

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = {
      ...config,
      cwd: resolveWorkingDirectory(config.cwd),
      allowedTools: config.allowedTools ?? ['web_search'],
      subagentProvider: config.subagentProvider ?? 'spawn',
      maxParallelResearchUnits: config.maxParallelResearchUnits ?? 2,
    }
    if (this.config.allowedTools?.includes(RESEARCH_TOOL_NAME)) {
      throw new Error(`allowedTools cannot include recursive tool "${RESEARCH_TOOL_NAME}"`)
    }
    if (this.config.allowedTools?.length === 0) {
      throw new Error('allowedTools must contain at least one research-capable tool when specified')
    }

    ctx.effect(
      () => async () => {
        this.accepting = false
        await disposeAll(
          [...this.active].map((run) => () => run.dispose()),
          'failed to dispose one or more active Deep Research runs',
        )
      },
      'deepResearch.drain()',
    )
  }

  async start(
    request: ResearchRequest,
    execution: ResearchStartContext = {},
  ): Promise<ResearchRun> {
    if (!this.accepting) throw new Error('deepResearch provider is not accepting new runs')
    if (!request.question.trim()) throw new Error('question must be a non-empty string')
    maxUnitsForRequest(request)
    this.assertSubagentProvider()
    return execution.parent === undefined
      ? this.startDirect(request, execution.signal)
      : this.startDelegated(request, execution.parent, execution.signal)
  }

  private assertSubagentProvider(): void {
    const provider = this.ctx.subagents.getProvider(this.config.subagentProvider)
    if (provider === undefined) {
      throw new Error(`subagent provider "${this.config.subagentProvider}" is not registered`)
    }
    const required = ['outputSchema', 'toolFilter', 'persona'] as const
    const missing = required.filter((capability) => !provider.capabilities[capability])
    if (missing.length > 0) {
      throw new Error(
        `subagent provider "${provider.name}" lacks required Deep Research capabilities: ${missing.join(', ')}`,
      )
    }
  }

  private publish(
    id: string,
    result: Promise<ResearchResult>,
    controller: AbortController,
    release: () => Promise<void>,
  ): ManagedResearchRun {
    let run: ManagedResearchRun
    run = new ManagedResearchRun(id, result, controller, release, () => {
      this.active.delete(run)
    })
    this.active.add(run)
    return run
  }

  private visibleToolNames(agent: Agent): string[] {
    return this.ctx.tools.schemas(agent).map((schema) => schema.name)
  }

  private assertUsefulTools(visible: readonly string[]): void {
    const missing = this.config.allowedTools.filter((name) => !visible.includes(name))
    if (missing.length > 0) {
      throw new Error(`configured research tools are not visible: ${missing.join(', ')}`)
    }
  }

  private researchToolRestriction(): ToolRestriction {
    return { allow: this.config.allowedTools }
  }

  private childAgentOptions(): AgentOptions | undefined {
    const { provider, model, maxTokens } = this.config
    if (provider === undefined && model === undefined && maxTokens === undefined) return undefined
    return {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
  }

  private driveMethod(
    driver: DshResearchMethodDriver,
    request: ResearchRequest,
    signal: AbortSignal,
    mode: 'direct' | 'delegated',
    startedAt: string,
  ): Promise<ResearchResult> {
    return executeResearchMethod(
      request,
      driver,
      { maxParallel: this.config.maxParallelResearchUnits },
      signal,
    )
      .then((outcome) =>
        materializeResult({
          requestQuestion: request.question,
          report: outcome.report,
          status: outcome.status,
          mode,
          provider: 'agent-adaptive',
          startedAt,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        }),
      )
      .catch((error) =>
        failedResult(request.question, mode, 'agent-adaptive', startedAt, error, signal.aborted),
      )
  }

  private async startDirect(
    request: ResearchRequest,
    upstream?: AbortSignal,
  ): Promise<ResearchRun> {
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    const signal = fuseSignal(controller, upstream)
    throwIfAborted(signal)

    const presets = this.ctx.get('agentPresets') as AgentPresetRuntime | undefined
    if (presets === undefined && this.config.preset !== undefined) {
      throw new Error(
        `preset "${this.config.preset}" was requested but no agentPresets roster is mounted`,
      )
    }
    const resolvedPreset =
      presets === undefined ? undefined : (await presets.resolve(this.config.preset)).id

    const defaultSelection = this.ctx.agentDefaultModel.currentSelection()
    const selection = {
      ...defaultSelection,
      provider: this.config.provider ?? defaultSelection.provider,
      model: this.config.model ?? defaultSelection.model,
    }
    const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
    const id = `research-${randomUUID()}`
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(id),
      meta: {
        cwd: this.config.cwd,
        ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
      },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...(this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens }),
      },
      signal,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, selectionRef)
        if (resolvedPreset !== undefined) await presets?.mount(agentCtx, resolvedPreset)
        const agent = agentCtx.agent
        if (agent === undefined)
          throw new Error('research coordinator has no scoped Agent identity')
        const visible = agentCtx.tools.schemas(agent).map((schema) => schema.name)
        this.assertUsefulTools(visible)
        agentCtx.tools.restrict(this.researchToolRestriction())
      },
    })

    if (!this.accepting) {
      await handle.dispose()
      throw new Error('deepResearch provider stopped while the run was starting')
    }

    const driver = new DshResearchMethodDriver(this.ctx, handle.agent, signal, {
      providerName: this.config.subagentProvider,
      researchToolFilter: this.researchToolRestriction(),
    })
    try {
      await driver.preparePlan(request, maxUnitsForRequest(request))
    } catch (error) {
      await failAfterDirectCleanup(error, driver, handle)
    }
    if (!this.accepting) {
      await failAfterDirectCleanup(
        new Error('deepResearch provider stopped while the run was starting'),
        driver,
        handle,
      )
    }

    const result = this.driveMethod(driver, request, signal, 'direct', startedAt)
    return this.publish(id, result, controller, async () => {
      await disposeDirectResources(driver, handle)
    })
  }

  private async startDelegated(
    request: ResearchRequest,
    parent: Agent,
    upstream?: AbortSignal,
  ): Promise<ResearchRun> {
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    const signal = fuseSignal(controller, upstream)
    throwIfAborted(signal)

    const visible = this.visibleToolNames(parent)
    this.assertUsefulTools(visible)
    const agentOptions = this.childAgentOptions()
    const driver = new DshResearchMethodDriver(this.ctx, parent, signal, {
      providerName: this.config.subagentProvider,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      researchToolFilter: this.researchToolRestriction(),
    })
    try {
      await driver.preparePlan(request, maxUnitsForRequest(request))
    } catch (error) {
      await driver.dispose()
      throw error
    }
    if (!this.accepting) {
      await driver.dispose()
      throw new Error('deepResearch provider stopped while the run was starting')
    }

    const id = `research-${randomUUID()}`
    const result = this.driveMethod(driver, request, signal, 'delegated', startedAt)
    return this.publish(id, result, controller, () => driver.dispose())
  }
}

export default AgentResearchEngine
