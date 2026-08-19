import type { Context } from '@deepseek-ai/cordis'
import type { ResearchRequest, ResearchResult, ResearchRun, ResearchStartContext } from './types.js'
import type {} from './service.js'

/** Small programmatic facade over the deployment-selected ResearchEngine. */
export interface ResearchClient {
  start(request: ResearchRequest, context?: ResearchStartContext): Promise<ResearchRun>
  run(request: ResearchRequest, context?: ResearchStartContext): Promise<ResearchResult>
}

/** Create a caller facade without introducing a second runtime. */
export function createResearchClient(ctx: Context): ResearchClient {
  return {
    start: (request, context) => ctx.deepResearch.start(request, context),
    async run(request, context) {
      const run = await ctx.deepResearch.start(request, context)
      try {
        return await run.result
      } finally {
        await run.dispose()
      }
    },
  }
}
