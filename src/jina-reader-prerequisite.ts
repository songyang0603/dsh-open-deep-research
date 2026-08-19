import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'jina-reader-prerequisite'

/** Runtime-only authorization value consumed by the opt-in MCP row. */
export interface JinaReaderPrerequisite {
  readonly authorization: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in the explicitly selected Jina Reader Profile. */
    jinaReaderPrerequisite?: JinaReaderPrerequisite
  }
}

/** Fail before Jina connection when the launching environment has no usable key. */
export function apply(ctx: Context): void {
  const key = process.env.JINA_API_KEY?.trim()
  if (!key) {
    throw new Error('Jina Reader Profile requires JINA_API_KEY in the launching environment')
  }
  ctx.provide('jinaReaderPrerequisite', { authorization: `Bearer ${key}` })
}
