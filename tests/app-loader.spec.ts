import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchResult, ResearchRun } from '../src/types.js'
import type {} from '../src/service.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
let temporaryRoot: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('built one-shot app through the real Cordis Loader', () => {
  it('maps argv directly to a replaceable ResearchEngine and exits after disposal', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-open-research-app-loader-'))
    const configPath = join(temporaryRoot, 'cordis.yml')
    await writeFile(
      configPath,
      [
        "- name: 'fixture-research-engine'",
        "- name: 'dsh-open-deep-research/app-startup'",
        "- name: 'dsh-open-deep-research/app-runner'",
        '',
      ].join('\n'),
    )

    const startupModule = await import(pathToFileURL(join(projectRoot, 'dist/app-startup.js')).href)
    const runnerModule = await import(pathToFileURL(join(projectRoot, 'dist/app-runner.js')).href)
    let stdout = ''
    let stderr = ''
    startupModule.internals.stdout = { write: (chunk: string) => (stdout += chunk) }
    startupModule.internals.stderr = { write: (chunk: string) => (stderr += chunk) }
    runnerModule.internals.stdout = { write: (chunk: string) => (stdout += chunk) }
    runnerModule.internals.stderr = { write: (chunk: string) => (stderr += chunk) }

    const canonical: ResearchResult = {
      title: 'Assembled app result',
      report: '# Assembled app result\n\nThe selected service handled the request.',
      sources: [],
      status: 'completed',
      metadata: {
        startedAt: '2026-08-17T00:00:00.000Z',
        completedAt: '2026-08-17T00:00:01.000Z',
        mode: 'direct',
        provider: 'fixture-replacement',
      },
    }
    const dispose = vi.fn(() => Promise.resolve())
    const start = vi.fn((): Promise<ResearchRun> =>
      Promise.resolve({
        id: 'assembled-app-run',
        result: Promise.resolve(canonical),
        cancel: vi.fn(),
        dispose,
      }),
    )
    const FixtureResearchEngine = {
      name: 'fixture-research-engine',
      apply(ctx: Context) {
        ctx.provide('deepResearch', { start })
      },
    }

    const exits: number[] = []
    context = new Context()
    context.baseUrl = pathToFileURL(temporaryRoot).href + '/'
    provideCmdline(context, {
      args: [
        '--purpose',
        'assembled test',
        '--breadth',
        'focused',
        '--language',
        'English',
        'Can the app run directly?',
      ],
      exit: (code) => exits.push(code),
    })
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['fixture-research-engine', FixtureResearchEngine],
      ['dsh-open-deep-research/app-startup', startupModule],
      ['dsh-open-deep-research/app-runner', runnerModule],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>

    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    await vi.waitFor(() => expect(exits).toEqual([0]))

    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(
      {
        question: 'Can the app run directly?',
        purpose: 'assembled test',
        breadth: 'focused',
        output: { language: 'English' },
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stdout).toBe(`${canonical.report}\n`)
    expect(stderr).toBe('')
    expect(context.get('agents')).toBeUndefined()

    startupModule.internals.stdout = process.stdout
    startupModule.internals.stderr = process.stderr
    runnerModule.internals.stdout = process.stdout
    runnerModule.internals.stderr = process.stderr
  })
})
