import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { DshResearchMethodDriver } from '../src/dsh-method-driver.js'
import type { ResearchPlan, ResearchUnit } from '../src/method.js'
import { ManagedResearchRun } from '../src/run.js'
import type { ResearchResult } from '../src/types.js'

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function phaseRun(
  id: string,
  result: Promise<SubagentResult>,
  dispose: () => Promise<void>,
): SubagentRun {
  return {
    id: SessionId(id),
    localAgent: undefined,
    result,
    dispose,
  }
}

describe('research lifecycle ownership', () => {
  it('attempts every phase disposal, retains a failed release, and never disposes twice', async () => {
    const firstResult = deferred<SubagentResult>()
    const secondResult = deferred<SubagentResult>()
    const firstDispose = vi.fn(() => Promise.reject(new Error('first phase did not quiesce')))
    const secondDispose = vi.fn(() => Promise.resolve())
    const runs = [
      phaseRun('phase-1', firstResult.promise, firstDispose),
      phaseRun('phase-2', secondResult.promise, secondDispose),
    ]
    const start = vi
      .fn<() => Promise<SubagentRun>>()
      .mockResolvedValueOnce(runs[0]!)
      .mockResolvedValueOnce(runs[1]!)
    const ctx = { subagents: { start } } as unknown as Context
    const signal = new AbortController().signal
    const driver = new DshResearchMethodDriver(ctx, {} as Agent, signal, {
      providerName: 'fixture',
    })
    const units: ResearchUnit[] = [
      { id: 'unit-1', title: 'One', question: 'One?', objective: 'Find one.' },
      { id: 'unit-2', title: 'Two', question: 'Two?', objective: 'Find two.' },
    ]
    const plan: ResearchPlan = { brief: 'Brief', units }

    const phasePromises = units.map((unit) =>
      driver.research({ question: 'Q' }, plan, unit, signal).catch(() => undefined),
    )
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    await Promise.resolve()

    const disposal = driver.dispose()
    await expect(disposal).rejects.toThrow('failed to dispose one or more research phase runs')
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
    expect(driver.dispose()).toBe(disposal)

    const aborted: SubagentResult = { output: [], stopReason: 'aborted' }
    firstResult.resolve(aborted)
    secondResult.resolve(aborted)
    await Promise.all(phasePromises)
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('keeps a public run owned and memoizes a failed release', async () => {
    const release = vi.fn(() => Promise.reject(new Error('release failed')))
    const onDisposed = vi.fn()
    const run = new ManagedResearchRun(
      'research-fixture',
      Promise.resolve({} as ResearchResult),
      new AbortController(),
      release,
      onDisposed,
    )

    const disposal = run.dispose()
    await expect(disposal).rejects.toThrow('release failed')
    expect(onDisposed).not.toHaveBeenCalled()
    expect(run.dispose()).toBe(disposal)
    expect(release).toHaveBeenCalledOnce()
  })
})
