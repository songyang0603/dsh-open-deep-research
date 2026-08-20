import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResearchEngine from '../src/service.js'
import type {
  ResearchRequest,
  ResearchResult,
  ResearchRun,
  ResearchStartContext,
} from '../src/types.js'
import { RESEARCH_TOOL_NAME } from '../src/provider.js'
import * as ResearchTool from '../src/tool.js'

class FakeResearchEngine extends ResearchEngine {
  seen: { request: ResearchRequest; execution?: ResearchStartContext } | undefined
  disposed = vi.fn<() => Promise<void>>(() => Promise.resolve())

  override start(request: ResearchRequest, execution?: ResearchStartContext): Promise<ResearchRun> {
    this.seen = execution === undefined ? { request } : { request, execution }
    const partial = request.question === 'Fallback?'
    const result: ResearchResult = {
      title: 'Fixture report',
      report: '# Fixture report\n\nA result with [one source](https://example.com/).',
      sources: [{ url: 'https://example.com/', title: 'one source' }],
      status: partial ? 'partial' : 'completed',
      ...(partial ? { error: 'final synthesis failed' } : {}),
      metadata: {
        startedAt: '2026-08-17T00:00:00.000Z',
        completedAt: '2026-08-17T00:00:01.000Z',
        mode: 'delegated',
        provider: 'fixture-engine',
      },
    }
    return Promise.resolve({
      id: 'fixture-run',
      result: Promise.resolve(result),
      cancel() {},
      dispose: this.disposed,
    })
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

describe('open_deep_research tool consumer', () => {
  it('delegates to the shared service with the exact calling Agent and disposes the run', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeResearchEngine)
    await ctx.plugin(ResearchTool)

    const parent = {} as Agent
    const signal = new AbortController().signal
    const outcome = await ctx.tools.execute({
      callId: CallId('research-call'),
      name: RESEARCH_TOOL_NAME,
      arguments: {
        question: 'What changed?',
        purpose: 'The outer model invented a purpose.',
        context: 'The outer model claims this unverified fact is already known.',
        breadth: 'broad',
        format: 'brief',
        language: 'English',
      },
      agent: parent,
      signal,
    })

    expect(outcome.isError).toBe(false)
    if (outcome.isError)
      throw new Error(outcome.content[0]?.type === 'text' ? outcome.content[0].text : 'tool failed')
    expect(outcome.value).toMatchObject({ title: 'Fixture report', status: 'completed' })
    expect(outcome.content).toEqual([
      {
        type: 'text',
        text: '# Fixture report\n\nA result with [one source](https://example.com/).',
      },
    ])
    expect(ctx.deepResearch).toBeInstanceOf(FakeResearchEngine)
    expect((ctx.deepResearch as FakeResearchEngine).seen).toMatchObject({
      request: {
        question: 'What changed?',
        breadth: 'broad',
        output: { format: 'brief', language: 'English' },
      },
      execution: { parent, signal },
    })
    expect((ctx.deepResearch as FakeResearchEngine).seen?.request).not.toHaveProperty('purpose')
    expect((ctx.deepResearch as FakeResearchEngine).seen?.request).not.toHaveProperty('context')
    const schema = ctx.tools.schemas(parent).find((tool) => tool.name === RESEARCH_TOOL_NAME)
    expect(schema?.description).toContain('do not pre-answer it or add model-generated facts')
    expect(schema?.parameters.properties).not.toHaveProperty('purpose')
    expect(schema?.parameters.properties).not.toHaveProperty('context')
    expect((ctx.deepResearch as FakeResearchEngine).disposed).toHaveBeenCalledOnce()
  })

  it('uses the direct human text from the current turn instead of model-authored framing', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeResearchEngine)
    await ctx.plugin(ResearchTool)

    const callId = CallId('human-bound-research-call')
    const session = Session.create(SessionId('human-bound-session'))
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'Compare the two projects using official sources.' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: RESEARCH_TOOL_NAME,
      arguments: JSON.stringify({ question: 'Expanded model-authored question.' }),
    })
    const parent = { session } as Agent

    const outcome = await ctx.tools.execute({
      callId,
      name: RESEARCH_TOOL_NAME,
      arguments: {
        question: 'Expanded model-authored question with unsupported facts.',
        purpose: 'Invented purpose.',
        context: 'Invented factual context.',
        breadth: 'broad',
        format: 'memo',
        language: 'English',
      },
      agent: parent,
      signal: new AbortController().signal,
    })

    expect(outcome.isError).toBe(false)
    expect((ctx.deepResearch as FakeResearchEngine).seen).toMatchObject({
      request: {
        question: 'Compare the two projects using official sources.',
        breadth: 'broad',
        output: { format: 'memo', language: 'English' },
      },
      execution: { parent },
    })
    expect((ctx.deepResearch as FakeResearchEngine).seen?.request).not.toHaveProperty('purpose')
    expect((ctx.deepResearch as FakeResearchEngine).seen?.request).not.toHaveProperty('context')
  })

  it('uses the root call to bind direct human text for a Code Mode sub-call', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeResearchEngine)
    await ctx.plugin(ResearchTool)

    const rootCallId = CallId('root-run-code-call')
    const subCallId = CallId('root-run-code-call:code:1')
    const session = Session.create(SessionId('code-mode-human-bound-session'))
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'Investigate the release using official sources only.' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: rootCallId,
      name: 'run_code',
      arguments: JSON.stringify({ code: 'tools.open_deep_research({ question: "..." })' }),
    })
    const parent = { session } as Agent

    const outcome = await ctx.tools.execute({
      callId: subCallId,
      rootCallId,
      name: RESEARCH_TOOL_NAME,
      arguments: {
        question: 'Model-authored question with unsupported release claims.',
        breadth: 'focused',
      },
      agent: parent,
      signal: new AbortController().signal,
    })

    expect(outcome.isError).toBe(false)
    expect((ctx.deepResearch as FakeResearchEngine).seen).toMatchObject({
      request: {
        question: 'Investigate the release using official sources only.',
        breadth: 'focused',
      },
      execution: { parent },
    })
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in ResearchTool).toBe(false)
  })

  it('makes a partial result visible in the model-facing rendered content', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeResearchEngine)
    await ctx.plugin(ResearchTool)

    const outcome = await ctx.tools.execute({
      callId: CallId('partial-research-call'),
      name: RESEARCH_TOOL_NAME,
      arguments: { question: 'Fallback?' },
      agent: {} as Agent,
      signal: new AbortController().signal,
    })

    expect(outcome.isError).toBe(false)
    if (outcome.isError) throw new Error('expected a partial value, not a tool error')
    expect(outcome.value).toMatchObject({ status: 'partial' })
    expect(outcome.content).toEqual([
      {
        type: 'text',
        text: [
          '> **Deep Research status: partial.** The result below may be incomplete.',
          '> **Detail:** final synthesis failed',
          '',
          '# Fixture report',
          '',
          'A result with [one source](https://example.com/).',
        ].join('\n'),
      },
    ])
  })
})
