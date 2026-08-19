import type { Context } from '@deepseek-ai/cordis'
import { createResearchClient } from 'dsh-open-deep-research'

/** Invoke the provider selected by the surrounding DSH composition. */
export async function researchQuestion(ctx: Context, question: string): Promise<string> {
  const result = await createResearchClient(ctx).run({
    question,
    output: { format: 'report', language: 'English' },
  })
  if (result.status === 'failed' || result.status === 'cancelled') {
    throw new Error(result.error ?? `research ${result.status}`)
  }
  return result.report
}
