import { Context } from '@deepseek-ai/cordis'
import { apply as applyMcpClient, type Config } from '@deepseek-ai/dsh-mcp-client'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number
  readonly method: string
  readonly params?: Record<string, unknown>
}

describe('Jina Reader-shaped MCP composition', () => {
  let context: Context
  const seenAuthorization: Array<string | null> = []

  beforeEach(async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      seenAuthorization.push(request.headers.get('authorization'))
      if (request.method !== 'POST') return new Response(null, { status: 405 })

      const message = (await request.json()) as JsonRpcRequest
      if (message.id === undefined) return new Response(null, { status: 202 })

      let result: Record<string, unknown>
      switch (message.method) {
        case 'initialize':
          result = {
            protocolVersion:
              (message.params?.protocolVersion as string | undefined) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'reader-fixture', version: '1.0.0' },
          }
          break
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'read_url',
                description: 'Read one public page.',
                inputSchema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { url: { type: 'string' } },
                  required: ['url'],
                },
              },
            ],
          }
          break
        case 'tools/call': {
          const args = message.params?.arguments as { url?: unknown } | undefined
          result = {
            content: [
              {
                type: 'text',
                text: [
                  `url: ${String(args?.url)}`,
                  'title: Fixture page',
                  'content: Page body from the Reader.',
                ].join('\n'),
              },
            ],
            isError: false,
          }
          break
        }
        default:
          throw new Error(`unexpected MCP request: ${message.method}`)
      }

      return Response.json(
        { jsonrpc: '2.0', id: message.id, result },
        { headers: { 'content-type': 'application/json' } },
      )
    })

    context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'reader',
      url: 'https://reader.fixture.invalid/v1?include_tools=read_url&max_tokens=8000',
      headers: { Authorization: 'Bearer fixture-jina-key' },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
    }
    await applyMcpClient(context, config)
  })

  afterEach(async () => {
    await context.fiber.dispose()
    vi.unstubAllGlobals()
    seenAuthorization.splice(0)
  })

  it('registers only the qualified read_url Tool and forwards the runtime header', () => {
    expect(context.tools.schemas().map((tool) => tool.name)).toEqual(['mcp__reader__read_url'])
    expect(seenAuthorization.length).toBeGreaterThan(0)
    expect(new Set(seenAuthorization)).toEqual(new Set(['Bearer fixture-jina-key']))
  })

  it('executes read_url through the actual DSH MCP Client transport', async () => {
    const outcome = await context.tools.execute({
      callId: CallId('reader-fixture-call'),
      name: 'mcp__reader__read_url',
      arguments: { url: 'https://example.com/official' },
      signal: new AbortController().signal,
    })

    expect(outcome.isError).toBe(false)
    expect(outcome.content[0]).toEqual({
      type: 'text',
      text: [
        'url: https://example.com/official',
        'title: Fixture page',
        'content: Page body from the Reader.',
      ].join('\n'),
    })
  })
})
