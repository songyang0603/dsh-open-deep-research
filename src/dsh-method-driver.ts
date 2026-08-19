import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import type {
  FindingOutcome,
  FindingPayload,
  PhaseOutcome,
  ResearchMethodDriver,
  ResearchPlan,
  ResearchUnit,
} from './method.js'
import {
  buildPlannerPrompt,
  buildResearchUnitPrompt,
  buildSynthesisPrompt,
  PLANNER_PERSONA,
  RESEARCHER_PERSONA,
  SYNTHESIS_PERSONA,
} from './prompt.js'
import type { ResearchRequest, ResearchStatus } from './types.js'

export const PLAN_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brief: { type: 'string' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          question: { type: 'string' },
          objective: { type: 'string' },
        },
        required: ['title', 'question', 'objective'],
      },
    },
  },
  required: ['brief', 'units'],
}

export const FINDING_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          access: { type: 'string', enum: ['search-result', 'page-read'] },
        },
        required: ['url', 'access'],
      },
    },
    limitations: { type: 'string' },
  },
  required: ['findings', 'sources'],
}

export const SYNTHESIS_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { report: { type: 'string' } },
  required: ['report'],
}

interface DriverOptions {
  readonly providerName: string
  readonly agentOptions?: AgentOptions
  readonly researchToolFilter?: ToolRestriction
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function statusFor(result: SubagentResult, hasValue: boolean): ResearchStatus {
  switch (result.stopReason) {
    case 'completed':
      return hasValue ? 'completed' : 'failed'
    case 'max-tokens':
      return hasValue ? 'partial' : 'failed'
    case 'aborted':
      return 'cancelled'
    default:
      return 'failed'
  }
}

function phaseError(stage: string, result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return result.structured === undefined
        ? `${stage} completed without the required structured output.`
        : undefined
    case 'max-tokens':
      return `${stage} reached its model output limit.`
    case 'aborted':
      return `${stage} was cancelled.`
    case 'refusal':
      return `${stage} was declined by the model.`
    case 'error':
      return `${stage} failed in the DSH Agent loop.`
    default:
      return `${stage} stopped with reason "${String(result.stopReason)}".`
  }
}

function normalizeSource(
  value: unknown,
): { url: string; title?: string; access: 'search-result' | 'page-read' } | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined
  if (value.access !== 'search-result' && value.access !== 'page-read') return undefined
  try {
    const url = new URL(value.url.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    const title = typeof value.title === 'string' ? value.title.trim() : ''
    return title
      ? { url: url.toString(), title, access: value.access }
      : { url: url.toString(), access: value.access }
  } catch {
    return undefined
  }
}

function findingPayload(value: unknown): FindingPayload | undefined {
  if (!isRecord(value) || typeof value.findings !== 'string' || !value.findings.trim()) {
    return undefined
  }
  if (!Array.isArray(value.sources)) return undefined
  const sources = value.sources
    .map(normalizeSource)
    .filter((source): source is NonNullable<typeof source> => source !== undefined)
  const limitations = typeof value.limitations === 'string' ? value.limitations.trim() : ''
  return {
    findings: value.findings.trim(),
    sources,
    ...(limitations ? { limitations } : {}),
  }
}

function synthesisReport(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.report !== 'string') return undefined
  return value.report.trim() || undefined
}

/** DSH Subagent-backed transport for the package-private adaptive method. */
export class DshResearchMethodDriver implements ResearchMethodDriver {
  private readonly active = new Set<SubagentRun>()
  private readonly pending = new Set<Promise<SubagentRun>>()
  private readonly releasing = new Map<SubagentRun, Promise<void>>()
  private preparedPlanner: SubagentRun | undefined
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly anchor: Agent,
    private readonly signal: AbortSignal,
    private readonly options: DriverOptions,
  ) {}

  /** Publish the planning child before the public ResearchRun crosses its start boundary. */
  async preparePlan(request: ResearchRequest, maxUnits: number): Promise<void> {
    if (this.preparedPlanner !== undefined) throw new Error('planning phase is already prepared')
    this.preparedPlanner = await this.startChild({
      label: 'Research planning',
      prompt: buildPlannerPrompt(request, maxUnits),
      persona: PLANNER_PERSONA,
      toolFilter: { allow: [] },
      outputSchema: PLAN_SCHEMA,
    })
  }

  async plan(
    request: ResearchRequest,
    maxUnits: number,
    _signal: AbortSignal,
  ): Promise<PhaseOutcome<unknown>> {
    const run =
      this.preparedPlanner ??
      (await this.startChild({
        label: 'Research planning',
        prompt: buildPlannerPrompt(request, maxUnits),
        persona: PLANNER_PERSONA,
        toolFilter: { allow: [] },
        outputSchema: PLAN_SCHEMA,
      }))
    this.preparedPlanner = undefined
    const result = await this.consume(run)
    const value = result.structured
    const status = statusFor(result, value !== undefined)
    const error = phaseError('Research planning', result)
    return {
      status,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    }
  }

  async research(
    request: ResearchRequest,
    plan: ResearchPlan,
    unit: ResearchUnit,
    _signal: AbortSignal,
  ): Promise<PhaseOutcome<FindingPayload>> {
    const run = await this.startChild({
      label: `Research: ${unit.title}`,
      prompt: buildResearchUnitPrompt(request, plan, unit),
      persona: RESEARCHER_PERSONA,
      ...(this.options.researchToolFilter === undefined
        ? {}
        : { toolFilter: this.options.researchToolFilter }),
      outputSchema: FINDING_SCHEMA,
    })
    const result = await this.consume(run)
    const value = findingPayload(result.structured)
    const status = statusFor(result, value !== undefined)
    const error =
      value === undefined && result.structured !== undefined
        ? `Research unit "${unit.title}" returned empty findings.`
        : phaseError(`Research unit "${unit.title}"`, result)
    return {
      status,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    }
  }

  async synthesize(
    request: ResearchRequest,
    plan: ResearchPlan,
    findings: readonly FindingOutcome[],
    _signal: AbortSignal,
  ): Promise<PhaseOutcome<string>> {
    const run = await this.startChild({
      label: 'Research synthesis',
      prompt: buildSynthesisPrompt(request, plan, findings),
      persona: SYNTHESIS_PERSONA,
      toolFilter: { allow: [] },
      outputSchema: SYNTHESIS_SCHEMA,
    })
    const result = await this.consume(run)
    const value = synthesisReport(result.structured)
    const status = statusFor(result, value !== undefined)
    const error =
      value === undefined && result.structured !== undefined
        ? 'Research synthesis returned an empty report.'
        : phaseError('Research synthesis', result)
    return {
      status,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    }
  }

  private async startChild(options: {
    readonly label: string
    readonly prompt: string
    readonly persona: string
    readonly toolFilter?: ToolRestriction
    readonly outputSchema: ObjectJsonSchema
  }): Promise<SubagentRun> {
    if (this.closed) throw new Error('research method driver is closed')
    this.signal.throwIfAborted()
    const starting = this.ctx.subagents.start(this.options.providerName, {
      label: options.label,
      prompt: [{ type: 'text', text: options.prompt }],
      parent: this.anchor,
      signal: this.signal,
      ...(this.options.agentOptions === undefined
        ? {}
        : { agentOptions: this.options.agentOptions }),
      ...(options.toolFilter === undefined ? {} : { toolFilter: options.toolFilter }),
      persona: options.persona,
      outputSchema: options.outputSchema,
    })
    this.pending.add(starting)
    let run: SubagentRun
    try {
      run = await starting
    } finally {
      this.pending.delete(starting)
    }
    this.active.add(run)
    if (this.closed || this.signal.aborted) {
      await this.release(run)
      this.signal.throwIfAborted()
      throw new Error('research method driver closed while a phase was starting')
    }
    return run
  }

  private release(run: SubagentRun): Promise<void> {
    const existing = this.releasing.get(run)
    if (existing !== undefined) return existing

    const release = Promise.resolve()
      .then(() => run.dispose())
      .then(() => {
        this.active.delete(run)
      })
    this.releasing.set(run, release)
    return release
  }

  private async consume(run: SubagentRun): Promise<SubagentResult> {
    try {
      return await run.result
    } finally {
      await this.release(run)
    }
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = (async () => {
      const pending = [...this.pending]
      const active = [...this.active]
      const outcomes = await Promise.allSettled([
        ...active.map((run) => this.release(run)),
        ...pending.map(async (starting) => {
          let run: SubagentRun
          try {
            run = await starting
          } catch {
            return
          }
          await this.release(run)
        }),
      ])
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome) => outcome.reason)
      if (failures.length > 0) {
        throw new AggregateError(failures, 'failed to dispose one or more research phase runs')
      }
    })()
    return this.disposal
  }
}
