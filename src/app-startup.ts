import type { Context } from '@deepseek-ai/cordis'
import type { AppExit, CmdlineArgs } from '@deepseek-ai/dsh-cmdline'
import { Command, CommanderError, Option } from 'commander'
import type { ResearchBreadth, ResearchOutputFormat, ResearchRequest } from './types.js'

/** Stable service published after the research app command line is valid. */
export const RESEARCH_STARTUP_SERVICE = 'openDeepResearchStartup'

/** Immutable invocation consumed by the one-shot research runner. */
export interface ResearchStartupValues {
  readonly request: ResearchRequest
  readonly json: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Parsed one-shot Deep Research invocation. */
    openDeepResearchStartup?: ResearchStartupValues
  }
}

/** Stable Cordis plugin name. */
export const name = 'open-deep-research-startup'

/** DSH launcher-owned arguments must exist before this app parses them. */
export const inject = ['cmdlineArgs']

interface CliOptions {
  readonly purpose?: string
  readonly context?: string
  readonly breadth?: ResearchBreadth
  readonly format?: ResearchOutputFormat
  readonly language?: string
  readonly json?: boolean
}

interface StartupIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/** Process streams used by Commander; tests replace these sinks. */
export const internals: StartupIo = {
  stdout: process.stdout,
  stderr: process.stderr,
}

function nonEmptyOption(program: Command, name: string, value?: string): string | undefined {
  if (value === undefined) return undefined
  if (value.trim() !== '') return value
  program.error(`error: ${name} must not be empty`, {
    exitCode: 2,
    code: 'commander.invalidArgument',
  })
}

function createRequest(
  program: Command,
  questionParts: readonly string[],
  options: CliOptions,
): ResearchRequest {
  const question = questionParts.join(' ').trim()
  if (question === '') {
    program.error('error: a research question is required', {
      exitCode: 2,
      code: 'commander.missingArgument',
    })
  }

  const purpose = nonEmptyOption(program, '--purpose', options.purpose)
  const context = nonEmptyOption(program, '--context', options.context)
  const language = nonEmptyOption(program, '--language', options.language)
  const output =
    options.format === undefined && language === undefined
      ? undefined
      : {
          ...(options.format === undefined ? {} : { format: options.format }),
          ...(language === undefined ? {} : { language }),
        }

  return {
    question,
    ...(purpose === undefined ? {} : { purpose }),
    ...(context === undefined ? {} : { context }),
    ...(options.breadth === undefined ? {} : { breadth: options.breadth }),
    ...(output === undefined ? {} : { output }),
  }
}

function researchCommand(publish: (values: ResearchStartupValues) => void): Command {
  const program = new Command()
    .name('dsh --profile research')
    .description('Run the selected DSH Deep Research engine once, print its result, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[question...]', 'the research question; multiple words are joined by spaces')
    .option('--purpose <text>', 'why the result is needed')
    .option('--context <text>', 'caller-supplied background or constraints')
    .addOption(
      new Option('--breadth <level>', 'maximum adaptive research fan-out').choices([
        'focused',
        'balanced',
        'broad',
      ]),
    )
    .addOption(
      new Option('--format <format>', 'requested presentation shape').choices([
        'report',
        'brief',
        'memo',
      ]),
    )
    .option('--language <language>', 'requested report language')
    .option('--json', 'write completed or partial ResearchResult output as JSON')
    .addHelpText(
      'after',
      `\nExamples:\n  dsh --profile research "What changed in DSH rc.8?"\n  dsh --profile research --breadth broad --format memo --language zh-CN "Compare two approaches"\n`,
    )

  program.action((questionParts: string[], options: CliOptions) => {
    publish({
      request: createRequest(program, questionParts, options),
      json: options.json === true,
    })
  })
  return program
}

/** Parse one DSH-hosted invocation and publish it only after complete validation. */
export function apply(ctx: Context): void {
  const args = ctx.get('cmdlineArgs') as CmdlineArgs | undefined
  const exit = ctx.get('appExit') as AppExit | undefined
  if (args === undefined || exit === undefined) {
    throw new Error(
      'open-deep-research-startup: the DSH launcher must provide cmdlineArgs and appExit',
    )
  }

  const program = researchCommand((values) => {
    ctx.provide(RESEARCH_STARTUP_SERVICE, values)
  })
  program.exitOverride().configureOutput({
    writeOut: (text) => void internals.stdout.write(text),
    writeErr: (text) => void internals.stderr.write(text),
  })

  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error
    exit(error.exitCode === 0 ? 0 : 2)
  }
}
