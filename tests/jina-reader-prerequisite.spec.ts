import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as JinaReaderPrerequisite from '../src/jina-reader-prerequisite.js'

let context: Context | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
})

describe('Jina Reader runtime prerequisite', () => {
  it('fails before publishing a service when the key is missing', async () => {
    vi.stubEnv('JINA_API_KEY', '')
    context = new Context()

    await expect(context.plugin(JinaReaderPrerequisite)).rejects.toThrow('requires JINA_API_KEY')
    expect(context.get('jinaReaderPrerequisite')).toBeUndefined()
  })

  it('publishes only a trimmed runtime authorization value and retracts it on disposal', async () => {
    vi.stubEnv('JINA_API_KEY', '  jina_fixture_key  ')
    context = new Context()
    const fiber = await context.plugin(JinaReaderPrerequisite)

    expect(context.get('jinaReaderPrerequisite')).toEqual({
      authorization: 'Bearer jina_fixture_key',
    })
    await fiber.dispose()
    expect(context.get('jinaReaderPrerequisite')).toBeUndefined()
  })
})
