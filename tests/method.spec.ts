import { describe, expect, it, vi } from 'vitest'
import {
  executeResearchMethod,
  maxUnitsForRequest,
  normalizePlan,
  type FindingPayload,
  type FindingOutcome,
  type PhaseOutcome,
  type ResearchMethodDriver,
  type ResearchPlan,
  type ResearchUnit,
} from '../src/method.js'
import type { ResearchRequest } from '../src/types.js'

function planWith(count: number): unknown {
  return {
    brief: 'Compare the requested systems.',
    units: Array.from({ length: count }, (_, index) => ({
      title: `Facet ${index + 1}`,
      question: `Question ${index + 1}?`,
      objective: `Investigate facet ${index + 1}.`,
    })),
  }
}

function finding(unit: ResearchUnit): FindingPayload {
  return {
    findings: `Findings for ${unit.id}`,
    sources: [{ url: `https://example.com/${unit.id}`, access: 'search-result' }],
  }
}

class FakeDriver implements ResearchMethodDriver {
  readonly researched: string[] = []
  synthesisCalls = 0

  constructor(
    private readonly planned: PhaseOutcome<unknown>,
    private readonly researchFn: (
      unit: ResearchUnit,
      signal: AbortSignal,
    ) => Promise<PhaseOutcome<FindingPayload>> = (unit) =>
      Promise.resolve({ status: 'completed', value: finding(unit) }),
    private readonly synthesisFn: (
      plan: ResearchPlan,
      findings: readonly FindingOutcome[],
      signal: AbortSignal,
    ) => Promise<PhaseOutcome<string>> = () =>
      Promise.resolve({ status: 'completed', value: '# Final report\n\nDone.' }),
  ) {}

  plan(): Promise<PhaseOutcome<unknown>> {
    return Promise.resolve(this.planned)
  }

  async research(
    _request: ResearchRequest,
    _plan: ResearchPlan,
    unit: ResearchUnit,
    signal: AbortSignal,
  ): Promise<PhaseOutcome<FindingPayload>> {
    this.researched.push(unit.id)
    return this.researchFn(unit, signal)
  }

  synthesize(
    _request: ResearchRequest,
    plan: ResearchPlan,
    findings: readonly FindingOutcome[],
    signal: AbortSignal,
  ): Promise<PhaseOutcome<string>> {
    this.synthesisCalls += 1
    return this.synthesisFn(plan, findings, signal)
  }
}

describe('adaptive research method', () => {
  it('maps breadth to a fan-out ceiling without forcing extra units', () => {
    expect(maxUnitsForRequest({ question: 'Q', breadth: 'focused' })).toBe(1)
    expect(maxUnitsForRequest({ question: 'Q' })).toBe(2)
    expect(maxUnitsForRequest({ question: 'Q', breadth: 'broad' })).toBe(3)

    const one = normalizePlan(planWith(1), { question: 'Q', breadth: 'broad' }, 3)
    expect(one.fallback).toBe(false)
    expect(one.plan.units).toHaveLength(1)
  })

  it('rejects an invalid runtime breadth instead of losing the fan-out cap', () => {
    const request = { question: 'Q', breadth: 'unbounded' } as unknown as ResearchRequest
    expect(() => maxUnitsForRequest(request)).toThrow(
      'breadth must be "focused", "balanced", or "broad"',
    )
  })

  it.each([
    ['empty units', { brief: 'Brief', units: [] }],
    ['over-cap units', planWith(3)],
    [
      'duplicate units',
      {
        brief: 'Brief',
        units: [
          { title: 'A', question: 'Same question?', objective: 'A' },
          { title: 'B', question: '  same   question? ', objective: 'B' },
        ],
      },
    ],
  ])('uses one whole-question unit for %s', (_label, candidate) => {
    const normalized = normalizePlan(candidate, { question: 'Original question?' }, 2)
    expect(normalized.fallback).toBe(true)
    expect(normalized.plan.units).toEqual([
      {
        id: 'unit-1',
        title: 'Original question?',
        question: 'Original question?',
        objective: 'Answer the research question directly.',
      },
    ])
  })

  it('bounds parallel units and gives synthesis plan-ordered findings', async () => {
    const deferred = (): {
      promise: Promise<void>
      resolve: () => void
    } => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      return { promise, resolve }
    }
    const gates = new Map(['unit-1', 'unit-2', 'unit-3'].map((id) => [id, deferred()]))
    const started: string[] = []
    let active = 0
    let maxObserved = 0
    let synthesisOrder: string[] = []
    const driver = new FakeDriver(
      { status: 'completed', value: planWith(3) },
      async (unit) => {
        started.push(unit.id)
        active += 1
        maxObserved = Math.max(maxObserved, active)
        await gates.get(unit.id)?.promise
        active -= 1
        return { status: 'completed', value: finding(unit) }
      },
      (_plan, findings, _signal) => {
        synthesisOrder = findings.map((entry) => entry.unit.id)
        return Promise.resolve({ status: 'completed', value: '# Ordered\n\nDone.' })
      },
    )

    const resultPromise = executeResearchMethod(
      { question: 'Compare three facets.', breadth: 'broad' },
      driver,
      { maxParallel: 2 },
      new AbortController().signal,
    )

    await vi.waitFor(() => expect(started).toEqual(['unit-1', 'unit-2']))
    gates.get('unit-2')?.resolve()
    await vi.waitFor(() => expect(started).toEqual(['unit-1', 'unit-2', 'unit-3']))
    gates.get('unit-3')?.resolve()
    gates.get('unit-1')?.resolve()

    const result = await resultPromise
    expect(maxObserved).toBe(2)
    expect(result.findings.map((entry) => entry.unit.id)).toEqual(['unit-1', 'unit-2', 'unit-3'])
    expect(synthesisOrder).toEqual(['unit-1', 'unit-2', 'unit-3'])
    expect(result.status).toBe('completed')
  })

  it('continues after one unit fails but skips synthesis when all units fail', async () => {
    const partialDriver = new FakeDriver({ status: 'completed', value: planWith(2) }, (unit) =>
      Promise.resolve(
        unit.id === 'unit-1'
          ? { status: 'failed', error: 'source unavailable' }
          : { status: 'completed', value: finding(unit) },
      ),
    )
    const partial = await executeResearchMethod(
      { question: 'Compare.', breadth: 'balanced' },
      partialDriver,
      { maxParallel: 2 },
      new AbortController().signal,
    )
    expect(partial.status).toBe('partial')
    expect(partialDriver.synthesisCalls).toBe(1)

    const failedDriver = new FakeDriver({ status: 'completed', value: planWith(2) }, () =>
      Promise.resolve({ status: 'failed', error: 'no result' }),
    )
    const failed = await executeResearchMethod(
      { question: 'Compare.' },
      failedDriver,
      { maxParallel: 2 },
      new AbortController().signal,
    )
    expect(failed.status).toBe('failed')
    expect(failedDriver.synthesisCalls).toBe(0)
  })

  it('returns an explicitly incomplete, limitation-preserving fallback when synthesis fails', async () => {
    const driver = new FakeDriver(
      { status: 'completed', value: planWith(2) },
      (unit) =>
        Promise.resolve(
          unit.id === 'unit-1'
            ? {
                status: 'completed',
                value: {
                  ...finding(unit),
                  limitations: 'The source page body was not available.',
                },
              }
            : { status: 'failed', error: 'source unavailable' },
        ),
      () => Promise.resolve({ status: 'failed', error: 'writer failed' }),
    )
    const result = await executeResearchMethod(
      { question: 'Summarize.', breadth: 'balanced' },
      driver,
      { maxParallel: 2 },
      new AbortController().signal,
    )

    expect(result.status).toBe('partial')
    expect(result.report).toContain('Incomplete research report')
    expect(result.report).toContain('Synthesis error:')
    expect(result.report).toContain('Findings for unit-1')
    expect(result.report).toContain('The source page body was not available.')
    expect(result.report).toContain('search result only')
    expect(result.report).toContain('Unavailable research unit (failed)')
    expect(result.report).toContain('source unavailable')
    expect(result.error).toContain('writer failed')
  })

  it('cancels before synthesis but keeps a terminal report captured before a racing abort', async () => {
    const planningController = new AbortController()
    const hangingDriver: ResearchMethodDriver = {
      plan: (_request, _maxUnits, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      research: () => Promise.resolve({ status: 'failed' }),
      synthesize: () => Promise.resolve({ status: 'failed' }),
    }
    const cancelledPromise = executeResearchMethod(
      { question: 'Cancel me.' },
      hangingDriver,
      { maxParallel: 1 },
      planningController.signal,
    )
    planningController.abort(new Error('cancelled by test'))
    await expect(cancelledPromise).resolves.toMatchObject({ status: 'cancelled', report: '' })

    const lateController = new AbortController()
    const lateDriver = new FakeDriver(
      { status: 'completed', value: planWith(1) },
      undefined,
      () => {
        lateController.abort(new Error('late abort'))
        return Promise.resolve({ status: 'completed', value: '# Terminal report\n\nDone.' })
      },
    )
    const terminal = await executeResearchMethod(
      { question: 'Finish.' },
      lateDriver,
      { maxParallel: 1 },
      lateController.signal,
    )
    expect(terminal).toMatchObject({ status: 'completed', report: '# Terminal report\n\nDone.' })
  })

  it('stops queued research units and cancels a hanging synthesis phase', async () => {
    const researchController = new AbortController()
    let signalTwoStarted!: () => void
    const twoStarted = new Promise<void>((resolve) => {
      signalTwoStarted = resolve
    })
    const researchDriver = new FakeDriver(
      { status: 'completed', value: planWith(3) },
      (unit, signal) =>
        new Promise((_resolve, reject) => {
          if (researchDriver.researched.length === 2) signalTwoStarted()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const researchResult = executeResearchMethod(
      { question: 'Cancel units.', breadth: 'broad' },
      researchDriver,
      { maxParallel: 2 },
      researchController.signal,
    )
    await twoStarted
    researchController.abort(new Error('stop units'))
    await expect(researchResult).resolves.toMatchObject({ status: 'cancelled' })
    expect(researchDriver.researched).toEqual(['unit-1', 'unit-2'])
    expect(researchDriver.synthesisCalls).toBe(0)

    const synthesisController = new AbortController()
    let signalSynthesisStarted!: () => void
    const synthesisStarted = new Promise<void>((resolve) => {
      signalSynthesisStarted = resolve
    })
    const synthesisDriver = new FakeDriver(
      { status: 'completed', value: planWith(1) },
      undefined,
      (_plan, _findings, signal) =>
        new Promise((_resolve, reject) => {
          signalSynthesisStarted()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const synthesisResult = executeResearchMethod(
      { question: 'Cancel synthesis.' },
      synthesisDriver,
      { maxParallel: 1 },
      synthesisController.signal,
    )
    await synthesisStarted
    synthesisController.abort(new Error('stop synthesis'))
    await expect(synthesisResult).resolves.toMatchObject({ status: 'cancelled', report: '' })
  })
})
