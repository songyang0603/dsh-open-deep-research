import { Context } from '@deepseek-ai/cordis'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AppRunner from '../src/app-runner.js'
import type { ResearchRequest, ResearchResult, ResearchRun } from '../src/types.js'

const request: ResearchRequest = { question: 'What changed?', breadth: 'focused' }

function result(status: ResearchResult['status'], error?: string): ResearchResult {
  return {
    title: 'Result',
    report: status === 'failed' || status === 'cancelled' ? '' : '# Result\n\nUseful answer.',
    sources: [],
    status,
    ...(error === undefined ? {} : { error }),
    metadata: {
      startedAt: '2026-08-17T00:00:00.000Z',
      completedAt: '2026-08-17T00:00:01.000Z',
      mode: 'direct',
      provider: 'fixture',
    },
  }
}

interface Harness {
  readonly context: Context
  readonly stdout: () => string
  readonly stderr: () => string
  readonly exits: number[]
  readonly start: ReturnType<typeof vi.fn>
}

let context: Context | undefined

afterEach(async () => {
  AppRunner.internals.stdout = process.stdout
  AppRunner.internals.stderr = process.stderr
  await context?.fiber.dispose()
  context = undefined
})

async function mount(
  runOrError: ResearchRun | Error,
  json = false,
  events?: string[],
): Promise<Harness> {
  let stdout = ''
  let stderr = ''
  const exits: number[] = []
  AppRunner.internals.stdout = {
    write: (chunk) => {
      events?.push('stdout')
      return (stdout += chunk)
    },
  }
  AppRunner.internals.stderr = { write: (chunk) => (stderr += chunk) }

  const start = vi.fn(() =>
    runOrError instanceof Error ? Promise.reject(runOrError) : Promise.resolve(runOrError),
  )
  context = new Context()
  context.provide('deepResearch', { start })
  context.provide('openDeepResearchStartup', { request, json })
  context.provide('appExit', ((code: number) => {
    events?.push('exit')
    exits.push(code)
  }) as AppExit)
  await context.plugin(AppRunner)
  return {
    context,
    stdout: () => stdout,
    stderr: () => stderr,
    exits,
    start,
  }
}

function settledRun(value: ResearchResult, events: string[] = []): ResearchRun {
  return {
    id: 'research-run',
    result: Promise.resolve(value),
    cancel: vi.fn(),
    dispose: vi.fn(() => {
      events.push('dispose')
      return Promise.resolve()
    }),
  }
}

async function waitForExit(harness: Harness): Promise<void> {
  await vi.waitFor(() => expect(harness.exits).toHaveLength(1))
}

describe('one-shot Deep Research app runner', () => {
  it('directly calls the selected engine once, disposes, then writes Markdown', async () => {
    const events: string[] = []
    const run = settledRun(result('completed'), events)
    const harness = await mount(run, false, events)
    await waitForExit(harness)

    expect(harness.start).toHaveBeenCalledTimes(1)
    expect(harness.start).toHaveBeenCalledWith(request, {
      signal: expect.any(AbortSignal),
    })
    expect(run.dispose).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['dispose', 'stdout', 'exit'])
    expect(harness.stdout()).toBe('# Result\n\nUseful answer.\n')
    expect(harness.stderr()).toBe('')
    expect(harness.exits).toEqual([0])
  })

  it('writes the canonical result as one JSON document', async () => {
    const value = result('completed')
    const harness = await mount(settledRun(value), true)
    await waitForExit(harness)

    expect(JSON.parse(harness.stdout())).toEqual(value)
    expect(harness.stdout()).toBe(`${JSON.stringify(value)}\n`)
    expect(harness.stderr()).toBe('')
    expect(harness.exits).toEqual([0])
  })

  it('keeps a partial report usable and makes its status visible on stderr', async () => {
    const harness = await mount(settledRun(result('partial', 'one unit was unavailable')))
    await waitForExit(harness)

    expect(harness.stdout()).toBe('# Result\n\nUseful answer.\n')
    expect(harness.stderr()).toBe('dsh-research: partial: one unit was unavailable\n')
    expect(harness.exits).toEqual([0])
  })

  it.each([result('failed', 'no usable finding'), result('cancelled', 'caller cancelled')])(
    'does not print a success payload for $status',
    async (value) => {
      const harness = await mount(settledRun(value))
      await waitForExit(harness)

      expect(harness.stdout()).toBe('')
      expect(harness.stderr()).toContain(value.status)
      expect(harness.stderr()).toContain(value.error)
      expect(harness.exits).toEqual([1])
    },
  )

  it('keeps failed JSON-mode output on stderr instead of emitting a success document', async () => {
    const harness = await mount(settledRun(result('failed', 'no usable finding')), true)
    await waitForExit(harness)

    expect(harness.stdout()).toBe('')
    expect(harness.stderr()).toBe('dsh-research: failed: no usable finding\n')
    expect(harness.exits).toEqual([1])
  })

  it('reports start rejection without printing a report', async () => {
    const harness = await mount(new Error('model route is not configured'))
    await waitForExit(harness)

    expect(harness.stdout()).toBe('')
    expect(harness.stderr()).toBe('dsh-research: model route is not configured\n')
    expect(harness.exits).toEqual([1])
  })

  it('does not report success when cleanup fails', async () => {
    const run: ResearchRun = {
      id: 'cleanup-failure',
      result: Promise.resolve(result('completed')),
      cancel: vi.fn(),
      dispose: vi.fn(() => Promise.reject(new Error('cleanup failed'))),
    }
    const harness = await mount(run)
    await waitForExit(harness)

    expect(harness.stdout()).toBe('')
    expect(harness.stderr()).toBe('dsh-research: cleanup failed\n')
    expect(harness.exits).toEqual([1])
  })

  it('cancels and drains an active run on app unload without late output or exit', async () => {
    let settle!: (value: ResearchResult) => void
    const pending = new Promise<ResearchResult>((resolve) => {
      settle = resolve
    })
    const run: ResearchRun = {
      id: 'pending',
      result: pending,
      cancel: vi.fn(() => settle(result('cancelled', 'application shutdown'))),
      dispose: vi.fn(() => pending.then(() => undefined)),
    }
    const harness = await mount(run)
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1))

    await harness.context.fiber.dispose()
    context = undefined

    expect(run.cancel).toHaveBeenCalledTimes(1)
    expect(run.dispose).toHaveBeenCalled()
    expect(harness.stdout()).toBe('')
    expect(harness.stderr()).toBe('')
    expect(harness.exits).toEqual([])
  })
})
