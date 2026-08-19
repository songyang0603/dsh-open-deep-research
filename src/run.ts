import type { ResearchResult, ResearchRun } from './types.js'

/** Caller-owned wrapper that couples a public result with its DSH resource. */
export class ManagedResearchRun implements ResearchRun {
  private disposal: Promise<void> | undefined

  constructor(
    readonly id: string,
    readonly result: Promise<ResearchResult>,
    private readonly controller: AbortController,
    private readonly release: () => Promise<void>,
    private readonly onDisposed: () => void,
  ) {}

  cancel(reason = 'research run cancelled'): void {
    if (!this.controller.signal.aborted) this.controller.abort(new Error(reason))
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.cancel('research run disposed')
    this.disposal = (async () => {
      const outcomes = await Promise.allSettled([this.release(), this.result])
      const releaseOutcome = outcomes[0]
      if (releaseOutcome?.status === 'rejected') throw releaseOutcome.reason
      this.onDisposed()
    })()
    return this.disposal
  }
}
