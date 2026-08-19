import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import * as AppStartup from '../src/app-startup.js'

let context: Context | undefined

afterEach(async () => {
  AppStartup.internals.stdout = process.stdout
  AppStartup.internals.stderr = process.stderr
  await context?.fiber.dispose()
  context = undefined
})

async function parse(args: readonly string[]): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly exits: number[]
  readonly context: Context
}> {
  let stdout = ''
  let stderr = ''
  const exits: number[] = []
  AppStartup.internals.stdout = { write: (chunk) => (stdout += chunk) }
  AppStartup.internals.stderr = { write: (chunk) => (stderr += chunk) }

  context = new Context()
  provideCmdline(context, {
    args,
    exit: (code) => exits.push(code),
  })
  await context.plugin(AppStartup)
  return {
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    exits,
    context,
  }
}

describe('Deep Research app startup', () => {
  it('maps the complete command line without adding omitted defaults', async () => {
    const parsed = await parse([
      '--purpose',
      'architecture decision',
      '--context',
      'Use official sources.',
      '--breadth',
      'broad',
      '--format',
      'memo',
      '--language',
      'zh-CN',
      '--json',
      'Compare',
      'the two designs',
    ])

    expect(parsed.context.get('openDeepResearchStartup')).toEqual({
      request: {
        question: 'Compare the two designs',
        purpose: 'architecture decision',
        context: 'Use official sources.',
        breadth: 'broad',
        output: { format: 'memo', language: 'zh-CN' },
      },
      json: true,
    })
    expect(parsed.exits).toEqual([])
    expect(parsed.stdout).toBe('')
    expect(parsed.stderr).toBe('')
  })

  it('keeps optional request fields absent', async () => {
    const parsed = await parse(['What', 'changed?'])

    expect(parsed.context.get('openDeepResearchStartup')).toEqual({
      request: { question: 'What changed?' },
      json: false,
    })
  })

  it.each([
    { args: [] as string[], message: 'a research question is required' },
    { args: ['   '], message: 'a research question is required' },
    { args: ['--breadth', 'unbounded', 'question'], message: 'Allowed choices' },
    { args: ['--format', 'slides', 'question'], message: 'Allowed choices' },
    { args: ['--purpose', '', 'question'], message: '--purpose must not be empty' },
    { args: ['--unknown', 'question'], message: 'unknown option' },
  ])('rejects invalid input before publishing: $args', async ({ args, message }) => {
    const parsed = await parse(args)

    expect(parsed.context.get('openDeepResearchStartup')).toBeUndefined()
    expect(parsed.exits).toEqual([2])
    expect(parsed.stdout).toBe('')
    expect(parsed.stderr).toContain(message)
  })

  it('prints app help and exits without publishing a request', async () => {
    const parsed = await parse(['--help'])

    expect(parsed.context.get('openDeepResearchStartup')).toBeUndefined()
    expect(parsed.exits).toEqual([0])
    expect(parsed.stdout).toContain('dsh --profile research')
    expect(parsed.stdout).toContain('--breadth <level>')
    expect(parsed.stderr).toBe('')
  })
})
