import type { Context } from '@deepseek-ai/cordis'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import { createResearchClient } from './client.js'
import type {} from './service.js'
import type { ResearchResult, ResearchRun } from './types.js'
import type {} from './app-startup.js'

/** Stable Cordis plugin name. */
export const name = 'open-deep-research-runner'

/** The runner starts only after both the domain service and parsed invocation exist. */
export const inject = ['deepResearch', 'openDeepResearchStartup']

interface RunnerIo {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
  readonly exit: AppExit
}

/** Process streams used by the one-shot runner; tests replace these sinks. */
export const internals = {
  stdout: process.stdout as RunnerIo['stdout'],
  stderr: process.stderr as RunnerIo['stderr'],
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeResult(result: ResearchResult, json: boolean, io: RunnerIo): void {
  if (result.status === 'completed' || result.status === 'partial') {
    io.stdout.write(`${json ? JSON.stringify(result) : result.report}\n`)
    if (result.status === 'partial') {
      io.stderr.write(
        `dsh-research: partial: ${result.error ?? 'the report is usable but incomplete'}\n`,
      )
    }
    io.exit(0)
    return
  }

  io.stderr.write(`dsh-research: ${result.status}: ${result.error ?? 'no report was produced'}\n`)
  io.exit(1)
}

async function disposeAfterFailure(run: ResearchRun, primary: unknown): Promise<never> {
  try {
    await run.dispose()
  } catch (cleanupError) {
    throw new AggregateError(
      [primary, cleanupError],
      'Deep Research execution and cleanup both failed',
    )
  }
  throw primary
}

async function execute(
  ctx: Context,
  io: RunnerIo,
  signal: AbortSignal,
  isClosing: () => boolean,
  setActive: (run: ResearchRun | undefined) => void,
): Promise<void> {
  await ctx.get('loader')?.await()
  if (isClosing()) return

  const startup = ctx.get('openDeepResearchStartup')
  if (startup === undefined) return

  const run = await createResearchClient(ctx).start(startup.request, { signal })
  setActive(run)

  let result: ResearchResult
  try {
    result = await run.result
  } catch (error) {
    return disposeAfterFailure(run, error)
  }

  await run.dispose()
  setActive(undefined)
  if (!isClosing()) writeResult(result, startup.json, io)
}

/** Run one parsed request and bind it to the DSH launcher's bounded process lifetime. */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as AppExit | undefined
  if (exit === undefined) {
    throw new Error('open-deep-research-runner: the DSH launcher must provide appExit')
  }

  const io: RunnerIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  const controller = new AbortController()
  let closing = false
  let active: ResearchRun | undefined
  let task: Promise<void> = Promise.resolve()

  ctx.effect(() => {
    task = execute(
      ctx,
      io,
      controller.signal,
      () => closing,
      (run) => {
        active = run
      },
    ).catch((error: unknown) => {
      if (closing) return
      io.stderr.write(`dsh-research: ${errorMessage(error)}\n`)
      io.exit(1)
    })

    return async () => {
      closing = true
      controller.abort(new Error('Deep Research application is shutting down'))
      active?.cancel('Deep Research application is shutting down')
      const outcomes = await Promise.allSettled([active?.dispose() ?? Promise.resolve(), task])
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      )
      if (failure !== undefined) throw failure.reason
    }
  }, 'openDeepResearchRunner.run()')
}
