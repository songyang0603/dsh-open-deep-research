import type { ResearchRequest, ResearchStatus } from './types.js'

/** Package-private plan unit produced by the planning phase. */
export interface ResearchUnit {
  readonly id: string
  readonly title: string
  readonly question: string
  readonly objective: string
}

/** Package-private resolved brief and adaptive unit plan. */
export interface ResearchPlan {
  readonly brief: string
  readonly units: ResearchUnit[]
}

/** Compact output from one research unit. */
export type FindingSourceAccess = 'search-result' | 'page-read'

/** One source used by a research unit before public report materialization. */
export interface FindingSource {
  readonly url: string
  readonly title?: string
  readonly access: FindingSourceAccess
}

/** Compact output from one research unit. */
export interface FindingPayload {
  readonly findings: string
  readonly sources: FindingSource[]
  readonly limitations?: string
}

/** One phase result before the public ResearchResult is materialized. */
export interface PhaseOutcome<T> {
  readonly status: ResearchStatus
  readonly value?: T
  readonly error?: string
}

/** Research finding paired with its stable plan position. */
export interface FindingOutcome extends PhaseOutcome<FindingPayload> {
  readonly unit: ResearchUnit
}

/** Internal driver boundary implemented with DSH subagents by the default Provider. */
export interface ResearchMethodDriver {
  plan(
    request: ResearchRequest,
    maxUnits: number,
    signal: AbortSignal,
  ): Promise<PhaseOutcome<unknown>>
  research(
    request: ResearchRequest,
    plan: ResearchPlan,
    unit: ResearchUnit,
    signal: AbortSignal,
  ): Promise<PhaseOutcome<FindingPayload>>
  synthesize(
    request: ResearchRequest,
    plan: ResearchPlan,
    findings: readonly FindingOutcome[],
    signal: AbortSignal,
  ): Promise<PhaseOutcome<string>>
}

/** Internal terminal value consumed by the Provider's canonical result mapper. */
export interface ResearchMethodOutcome {
  readonly report: string
  readonly status: ResearchStatus
  readonly error?: string
  readonly plan: ResearchPlan
  readonly findings: readonly FindingOutcome[]
  readonly usedFallbackPlan: boolean
}

const DEFAULT_BREADTH = 'balanced'

/** Convert caller breadth into a hard upper bound without forcing fan-out. */
export function maxUnitsForRequest(request: ResearchRequest): number {
  const breadth: unknown = request.breadth ?? DEFAULT_BREADTH
  switch (breadth) {
    case 'focused':
      return 1
    case 'balanced':
      return 2
    case 'broad':
      return 3
    default:
      throw new TypeError(
        `breadth must be "focused", "balanced", or "broad"; received ${JSON.stringify(breadth)}`,
      )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function wholeQuestionBrief(request: ResearchRequest): string {
  const parts = [request.question.trim()]
  if (request.purpose?.trim()) parts.push(`Purpose: ${request.purpose.trim()}`)
  if (request.context?.trim()) parts.push(`Context: ${request.context.trim()}`)
  return parts.join('\n\n')
}

/** Deterministic single-unit plan used when the planning phase cannot supply a valid plan. */
export function fallbackPlan(request: ResearchRequest): ResearchPlan {
  return {
    brief: wholeQuestionBrief(request),
    units: [
      {
        id: 'unit-1',
        title: request.question.trim(),
        question: request.question.trim(),
        objective: request.purpose?.trim() || 'Answer the research question directly.',
      },
    ],
  }
}

/** Validate planner semantics that the DSH structured-output schema cannot express. */
export function normalizePlan(
  candidate: unknown,
  request: ResearchRequest,
  maxUnits: number,
): { readonly plan: ResearchPlan; readonly fallback: boolean; readonly error?: string } {
  const useFallback = (error: string) => ({
    plan: fallbackPlan(request),
    fallback: true as const,
    error,
  })

  if (!isRecord(candidate)) return useFallback('Planner did not return an object plan.')
  const brief = nonEmptyString(candidate.brief)
  if (brief === undefined) return useFallback('Planner returned an empty research brief.')
  if (!Array.isArray(candidate.units)) return useFallback('Planner did not return research units.')
  if (candidate.units.length === 0 || candidate.units.length > maxUnits) {
    return useFallback(`Planner returned ${candidate.units.length} units; expected 1-${maxUnits}.`)
  }

  const seen = new Set<string>()
  const units: ResearchUnit[] = []
  for (const [index, raw] of candidate.units.entries()) {
    if (!isRecord(raw)) return useFallback(`Planner unit ${index + 1} is not an object.`)
    const title = nonEmptyString(raw.title)
    const question = nonEmptyString(raw.question)
    const objective = nonEmptyString(raw.objective)
    if (title === undefined || question === undefined || objective === undefined) {
      return useFallback(`Planner unit ${index + 1} has an empty title, question, or objective.`)
    }
    const duplicateKey = question.toLocaleLowerCase().replace(/\s+/gu, ' ')
    if (seen.has(duplicateKey)) {
      return useFallback(`Planner returned duplicate research unit question: ${question}`)
    }
    seen.add(duplicateKey)
    units.push({ id: `unit-${index + 1}`, title, question, objective })
  }

  return { plan: { brief, units }, fallback: false }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failedFinding(unit: ResearchUnit, error: unknown, cancelled: boolean): FindingOutcome {
  return {
    unit,
    status: cancelled ? 'cancelled' : 'failed',
    error: errorMessage(error),
  }
}

async function runUnits(
  request: ResearchRequest,
  plan: ResearchPlan,
  driver: ResearchMethodDriver,
  maxParallel: number,
  signal: AbortSignal,
): Promise<FindingOutcome[]> {
  const findings: Array<FindingOutcome | undefined> = Array.from({ length: plan.units.length })
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      const unit = plan.units[index]
      if (unit === undefined) return
      try {
        const outcome = await driver.research(request, plan, unit, signal)
        findings[index] = { unit, ...outcome }
      } catch (error) {
        findings[index] = failedFinding(unit, error, signal.aborted)
      }
    }
  }

  const workerCount = Math.min(Math.max(1, maxParallel), plan.units.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return findings.filter((finding): finding is FindingOutcome => finding !== undefined)
}

function usableFinding(finding: FindingOutcome): finding is FindingOutcome & {
  readonly value: FindingPayload
} {
  return (
    (finding.status === 'completed' || finding.status === 'partial') &&
    finding.value !== undefined &&
    Boolean(finding.value.findings.trim())
  )
}

function joinErrors(errors: Array<string | undefined>): string | undefined {
  const unique = [...new Set(errors.filter((error): error is string => Boolean(error?.trim())))]
  return unique.length === 0 ? undefined : unique.join(' ')
}

function findingsFallbackReport(
  request: ResearchRequest,
  findings: readonly FindingOutcome[],
  synthesisError?: string,
): string {
  const sections = [
    `# ${request.question.trim()}`,
    [
      '> **Incomplete research report:** final synthesis did not complete. This is an automatic aggregation of available research-unit findings, not a synthesized final answer.',
      ...(synthesisError?.trim() ? [`> **Synthesis error:** ${synthesisError.trim()}`] : []),
    ].join('\n'),
  ]
  for (const finding of findings) {
    if (!usableFinding(finding)) {
      const detail = finding.error?.trim() ? ` ${finding.error.trim()}` : ''
      sections.push(
        `## ${finding.unit.title}\n\n> **Unavailable research unit (${finding.status}).**${detail}`,
      )
      continue
    }

    const unitSections = [`## ${finding.unit.title}`, finding.value.findings.trim()]
    if (finding.status !== 'completed') {
      const detail = finding.error?.trim() ? ` ${finding.error.trim()}` : ''
      unitSections.push(`> **Unit status: ${finding.status}.**${detail}`)
    }
    if (finding.value.limitations?.trim()) {
      unitSections.push(`### Limitations\n\n${finding.value.limitations.trim()}`)
    }
    if (finding.value.sources.length > 0) {
      const links = finding.value.sources.map((source) => {
        const title = source.title?.trim() || source.url
        const access = source.access === 'page-read' ? 'page read' : 'search result only'
        return `- [${title}](${source.url}) — ${access}`
      })
      unitSections.push(`### Sources\n\n${links.join('\n')}`)
    }
    sections.push(unitSections.join('\n\n'))
  }
  return sections.join('\n\n')
}

/** Execute the bounded adaptive method independently of its DSH phase transport. */
export async function executeResearchMethod(
  request: ResearchRequest,
  driver: ResearchMethodDriver,
  options: { readonly maxParallel: number },
  signal: AbortSignal,
): Promise<ResearchMethodOutcome> {
  const maxUnits = maxUnitsForRequest(request)
  let planAttempt: PhaseOutcome<unknown>
  try {
    planAttempt = await driver.plan(request, maxUnits, signal)
  } catch (error) {
    planAttempt = {
      status: signal.aborted ? 'cancelled' : 'failed',
      error: errorMessage(error),
    }
  }

  if (signal.aborted || planAttempt.status === 'cancelled') {
    return {
      report: '',
      status: 'cancelled',
      error: planAttempt.error ?? errorMessage(signal.reason ?? 'research run cancelled'),
      plan: fallbackPlan(request),
      findings: [],
      usedFallbackPlan: true,
    }
  }

  const normalized =
    planAttempt.status === 'completed' && planAttempt.value !== undefined
      ? normalizePlan(planAttempt.value, request, maxUnits)
      : {
          plan: fallbackPlan(request),
          fallback: true as const,
          error: planAttempt.error ?? 'Planning did not complete.',
        }

  const findings = await runUnits(request, normalized.plan, driver, options.maxParallel, signal)
  if (signal.aborted || findings.some((finding) => finding.status === 'cancelled')) {
    return {
      report: '',
      status: 'cancelled',
      error: errorMessage(signal.reason ?? 'research run cancelled'),
      plan: normalized.plan,
      findings,
      usedFallbackPlan: normalized.fallback,
    }
  }

  const usable = findings.filter(usableFinding)
  if (usable.length === 0) {
    return {
      report: '',
      status: 'failed',
      error:
        joinErrors([normalized.error, ...findings.map((finding) => finding.error)]) ??
        'No research unit produced usable findings.',
      plan: normalized.plan,
      findings,
      usedFallbackPlan: normalized.fallback,
    }
  }

  let synthesis: PhaseOutcome<string>
  try {
    synthesis = await driver.synthesize(request, normalized.plan, findings, signal)
  } catch (error) {
    synthesis = {
      status: signal.aborted ? 'cancelled' : 'failed',
      error: errorMessage(error),
    }
  }

  const synthesizedReport = synthesis.value?.trim() ?? ''
  if (!synthesizedReport && (signal.aborted || synthesis.status === 'cancelled')) {
    return {
      report: '',
      status: 'cancelled',
      error: synthesis.error ?? errorMessage(signal.reason ?? 'research run cancelled'),
      plan: normalized.plan,
      findings,
      usedFallbackPlan: normalized.fallback,
    }
  }

  const report = synthesizedReport || findingsFallbackReport(request, findings, synthesis.error)
  const incomplete =
    normalized.fallback ||
    findings.some((finding) => finding.status !== 'completed') ||
    synthesis.status !== 'completed' ||
    !synthesizedReport
  const error = joinErrors([
    normalized.error,
    ...findings.map((finding) => finding.error),
    synthesis.error,
  ])

  return {
    report,
    status: incomplete ? 'partial' : 'completed',
    ...(error === undefined ? {} : { error }),
    plan: normalized.plan,
    findings,
    usedFallbackPlan: normalized.fallback,
  }
}
