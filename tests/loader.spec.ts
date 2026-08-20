import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  CallId,
  LlmAdapter,
  LlmRuntime,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { createResearchClient } from '../src/client.js'
import { RESEARCH_TOOL_NAME } from '../src/provider.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
let temporaryRoot: string | undefined
let context: Context | undefined

function toolCallResponse(name: string, args: unknown, id: string): StreamChunk[] {
  const callId = CallId(id)
  const raw = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: raw },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: raw },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: raw.length } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class AdaptiveAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = JSON.stringify(options.messages)
    if (messages.includes('research:planning')) {
      yield* toolCallResponse(
        'structured_output',
        {
          brief: 'Find and summarize one source.',
          units: [
            {
              title: 'Source',
              question: 'What does the source say?',
              objective: 'Find the relevant statement.',
            },
          ],
        },
        'loader-plan',
      )
      return
    }
    if (messages.includes('research:unit:unit-1')) {
      if (!messages.includes('https://example.com/')) {
        yield* toolCallResponse('web_search', { queries: ['fixture source'] }, 'loader-search')
        return
      }
      yield* toolCallResponse(
        'structured_output',
        {
          findings: 'The built composition can use the registered source tool.',
          sources: [
            { url: 'https://example.com/', title: 'fixture source', access: 'search-result' },
          ],
        },
        'loader-finding',
      )
      return
    }
    if (messages.includes('research:synthesis')) {
      yield* toolCallResponse(
        'structured_output',
        {
          report:
            '# Built adaptive report\n\nThe Loader-composed Provider used its [fixture source](https://example.com/).',
        },
        'loader-synthesis',
      )
      return
    }
    throw new Error(`unexpected Loader test request: ${messages}`)
  }
}

class HangingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await new Promise<never>((_resolve, reject) => {
      const fail = (): void => {
        reject(
          options.signal?.reason instanceof Error ? options.signal.reason : new Error('aborted'),
        )
      }
      if (options.signal?.aborted) fail()
      else options.signal?.addEventListener('abort', fail, { once: true })
    })
  }
}

const SourceTool = {
  name: 'fixture-research-source',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.tools.register(
      defineTool({
        name: 'web_search',
        description: 'Loader fixture source.',
        parameters: {
          queries: { type: 'array', required: true, items: { type: 'string' } },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { url: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.url }],
        },
        execute: () => Promise.resolve({ url: 'https://example.com/' }),
      }),
    )
  },
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

async function loadBuiltComposition(): Promise<Context> {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-open-research-loader-'))
  const configPath = join(temporaryRoot, 'cordis.yml')
  await writeFile(
    configPath,
    [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      "    provider: 'mock'",
      "    model: 'research-model'",
      "- name: '@deepseek-ai/dsh-subagent'",
      "- name: '@deepseek-ai/dsh-subagent-spawn-in-process'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
      "- name: 'fixture-research-source'",
      "- name: 'dsh-open-deep-research/provider'",
      "- name: 'dsh-open-deep-research/tool'",
      '',
    ].join('\n'),
  )

  const providerModule = await import(pathToFileURL(join(projectRoot, 'dist/provider.js')).href)
  const toolModule = await import(pathToFileURL(join(projectRoot, 'dist/tool.js')).href)

  context = new Context()
  context.baseUrl = pathToFileURL(temporaryRoot).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', SpawnInProcess],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['fixture-research-source', SourceTool],
    ['dsh-open-deep-research/provider', providerModule],
    ['dsh-open-deep-research/tool', toolModule],
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
  return context
}

describe('built package through the real Cordis Loader', () => {
  it('runs the adaptive method through the built Client and Provider subpath', async () => {
    const loaded = await loadBuiltComposition()
    loaded.llm.registerAdapter(['mock'], new AdaptiveAdapter())

    const result = await createResearchClient(loaded).run({
      question: 'Can the built package research?',
      breadth: 'focused',
    })

    expect(result).toMatchObject({
      title: 'Built adaptive report',
      status: 'completed',
      sources: [{ url: 'https://example.com/', title: 'fixture source' }],
      metadata: { mode: 'direct', provider: 'agent-adaptive' },
    })
    expect(loaded.agents.list()).toEqual([])
  })

  it('runs the built Tool through the same adaptive Provider with an explicit parent', async () => {
    const loaded = await loadBuiltComposition()
    loaded.llm.registerAdapter(['mock'], new AdaptiveAdapter())
    const parent = await loaded.agents.create({
      sessionId: SessionId('loader-parent'),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'mock', model: 'research-model' },
    })

    const outcome = await loaded.tools.execute({
      callId: CallId('loader-research-call'),
      name: RESEARCH_TOOL_NAME,
      arguments: { question: 'Can the built tool research?', breadth: 'focused' },
      agent: parent.agent,
      signal: new AbortController().signal,
    })

    expect(outcome.isError).toBe(false)
    if (outcome.isError) throw new Error('expected the assembled research tool to succeed')
    expect(outcome.value).toMatchObject({
      title: 'Built adaptive report',
      status: 'completed',
      metadata: { mode: 'delegated', provider: 'agent-adaptive' },
    })
    expect(loaded.agents.list()).toEqual([parent.agent])
    await parent.dispose()
  })

  it('loads both subpaths and drains a live run when the provider unloads', async () => {
    const loaded = await loadBuiltComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter((entry) => entry.fiber === undefined && !entry.disabled)
      .map((entry) => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('deepResearch')).toBeDefined()
    expect(loaded.tools.get(RESEARCH_TOOL_NAME)).toBeDefined()

    loaded.llm.registerAdapter(['mock'], new HangingAdapter())
    const run = await createResearchClient(loaded).start({ question: 'Wait until unload.' })
    const providerEntry = [...loaded.loader.entries()].find(
      (entry) => entry.options.name === 'dsh-open-deep-research/provider',
    )
    if (providerEntry?.fiber === undefined) throw new Error('expected a live provider entry')

    await providerEntry.fiber.dispose()
    const result = await run.result
    expect(result.status).toBe('cancelled')
    await run.dispose()
    expect(loaded.get('deepResearch')).toBeUndefined()
    expect(loaded.tools.get(RESEARCH_TOOL_NAME)).toBeUndefined()
    expect(loaded.agents.list()).toEqual([])
  })
})
