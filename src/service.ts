import { Context, Service } from '@deepseek-ai/cordis'
import type { ResearchRequest, ResearchRun, ResearchStartContext } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-selected Deep Research implementation. */
    deepResearch: ResearchEngine
  }
}

/** Replaceable domain seam for Deep Research. */
export abstract class ResearchEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'deepResearch')
  }

  /** Establish and publish one caller-owned research run. */
  abstract start(request: ResearchRequest, context?: ResearchStartContext): Promise<ResearchRun>
}

export default ResearchEngine
