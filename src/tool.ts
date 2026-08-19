import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './service.js'
import { RESEARCH_TOOL_NAME } from './provider.js'

/** Stable Cordis plugin name. */
export const name = 'tool-open-deep-research'

/** Services required by the model-facing consumer. */
export const inject = ['tools', 'deepResearch']

export type Config = Record<string, never>
export const Config: z<Config> = z.object({}) as z<Config>

const parameters = {
  question: {
    type: 'string',
    required: true,
    description: 'The concrete question to investigate and answer.',
  },
  purpose: {
    type: 'string',
    description: 'Why the answer is needed, when this changes emphasis or depth.',
  },
  context: {
    type: 'string',
    description: 'Known facts, constraints, definitions, or background for the research.',
  },
  breadth: {
    type: 'string',
    enum: ['focused', 'balanced', 'broad'],
    description:
      'Maximum research fan-out: focused=1, balanced=up to 2, broad=up to 3. This does not force extra branches.',
  },
  format: {
    type: 'string',
    enum: ['report', 'brief', 'memo'],
    description: 'Desired presentation shape for the answer.',
  },
  language: {
    type: 'string',
    description: 'Language for the final answer. Defaults to the question language.',
  },
} as const

/** Register the thin model-facing adapter over ctx.deepResearch. */
export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: RESEARCH_TOOL_NAME,
      description:
        'Delegate a substantial question to a focused Deep Research Agent that can search, synthesize, and return a cited report.',
      parameters,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            report: { type: 'string', required: true },
            sources: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  url: { type: 'string', required: true },
                  title: { type: 'string' },
                },
              },
            },
            status: {
              type: 'string',
              required: true,
              enum: ['completed', 'partial', 'cancelled', 'failed'],
            },
            error: { type: 'string' },
            metadata: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                startedAt: { type: 'string', required: true },
                completedAt: { type: 'string', required: true },
                mode: {
                  type: 'string',
                  required: true,
                  enum: ['direct', 'delegated'],
                },
                provider: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.status === 'completed') return [{ type: 'text', text: value.report }]
          const warning = [
            `> **Deep Research status: ${value.status}.** The result below may be incomplete.`,
            ...(value.error?.trim() ? [`> **Detail:** ${value.error.trim()}`] : []),
          ].join('\n')
          return [
            {
              type: 'text',
              text: value.report.trim() ? `${warning}\n\n${value.report}` : warning,
            },
          ]
        },
      },
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error(`${RESEARCH_TOOL_NAME} requires a calling DSH Agent`)
        }
        const run = await ctx.deepResearch.start(
          {
            question: args.question,
            ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
            ...(args.context === undefined ? {} : { context: args.context }),
            ...(args.breadth === undefined ? {} : { breadth: args.breadth }),
            ...(args.format === undefined && args.language === undefined
              ? {}
              : {
                  output: {
                    ...(args.format === undefined ? {} : { format: args.format }),
                    ...(args.language === undefined ? {} : { language: args.language }),
                  },
                }),
          },
          { parent: exec.agent, signal: exec.signal },
        )
        try {
          const result = await run.result
          if (result.status === 'failed' || result.status === 'cancelled') {
            throw new Error(result.error ?? `research run ${result.status}`)
          }
          return result
        } finally {
          await run.dispose()
        }
      },
    }),
  )
}
