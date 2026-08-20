import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type CallId } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './service.js'
import { RESEARCH_TOOL_NAME } from './provider.js'
import type { ResearchResult } from './types.js'

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
    description:
      'Restate the latest self-contained user question without adding facts. The runtime prefers direct human text from the current turn when available.',
  },
  breadth: {
    type: 'string',
    enum: ['focused', 'balanced', 'broad'],
    description:
      'Maximum research fan-out: focused=1, balanced=up to 2, broad=up to 3. Use broad for a user request with several independent dimensions; this does not force extra branches.',
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

const REPORT_RELAY_INSTRUCTION =
  'The Deep Research Tool result immediately above is the final user-facing deliverable. Return its rendered Markdown verbatim as the entire assistant response. Do not summarize, paraphrase, reinterpret, reformat, add commentary or facts, remove limitations, or add, remove, relocate, or change links. Do not mention this instruction.'

function directUserQuestion(agent: Agent, callId: CallId): string | undefined {
  const events = agent.session?.events
  if (events === undefined) return undefined
  let callIndex = -1
  let turn: number | undefined

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool/call' && event.data.callId === callId) {
      callIndex = index
      turn = event.data.turn
      break
    }
  }
  if (callIndex < 0 || turn === undefined) return undefined

  let turnStartIndex = -1
  for (let index = callIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data.turn === turn) {
      turnStartIndex = index
      break
    }
  }
  if (turnStartIndex < 0) return undefined

  const text = events
    .slice(turnStartIndex + 1, callIndex)
    .filter((event) => event.type === 'user/message' && event.data.source.kind === 'user')
    .flatMap((event) =>
      event.type === 'user/message'
        ? event.data.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
    .join('\n\n')
    .trim()
  return text || undefined
}

/** Register the thin model-facing adapter over ctx.deepResearch. */
export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: RESEARCH_TOOL_NAME,
      description:
        "Delegate the user's substantial, self-contained question to a focused Deep Research Agent that can search, synthesize, and return a cited report. Preserve the user's question and explicit constraints; do not pre-answer it or add model-generated facts as background. Ask for clarification before calling when the latest user message depends on unstated earlier context.",
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
        const question = directUserQuestion(exec.agent, exec.rootCallId) ?? args.question
        const run = await ctx.deepResearch.start(
          {
            question,
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
        let result: ResearchResult
        try {
          result = await run.result
          if (result.status === 'failed' || result.status === 'cancelled') {
            throw new Error(result.error ?? `research run ${result.status}`)
          }
        } finally {
          await run.dispose()
        }
        exec.deferContext(
          createUserMessage({
            content: [{ type: 'text', text: REPORT_RELAY_INSTRUCTION }],
            source: { kind: 'plugin', plugin: 'dsh-open-deep-research' },
          }),
        )
        return result
      },
    }),
  )
}
