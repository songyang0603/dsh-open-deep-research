import type { Agent } from '@deepseek-ai/dsh-agent'

/** The presentation shape requested for the final answer. */
export type ResearchOutputFormat = 'report' | 'brief' | 'memo'

/** Maximum adaptive research fan-out; it does not promise latency or answer depth. */
export type ResearchBreadth = 'focused' | 'balanced' | 'broad'

/** Serializable domain input accepted by every ResearchEngine provider. */
export interface ResearchRequest {
  /** The question the research run must answer. */
  readonly question: string
  /** Why the caller needs the result, when that changes emphasis or depth. */
  readonly purpose?: string
  /** Caller-supplied facts, constraints, or background. */
  readonly context?: string
  /** Maximum research fan-out. Defaults to balanced; focused questions may still use one unit. */
  readonly breadth?: ResearchBreadth
  /** Final-answer preferences. */
  readonly output?: {
    readonly format?: ResearchOutputFormat
    readonly language?: string
  }
}

/** Live execution context kept separate from the serializable request. */
export interface ResearchStartContext {
  /** Calling Agent. Presence means the run must remain a delegated child. */
  readonly parent?: Agent
  /** Caller-owned cooperative cancellation. */
  readonly signal?: AbortSignal
}

/** One normalized HTTP(S) source cited by the completed report. */
export interface ResearchSource {
  readonly url: string
  readonly title?: string
}

/** Why the public run stopped. */
export type ResearchStatus = 'completed' | 'partial' | 'cancelled' | 'failed'

/** Which DSH execution path produced the result. */
export type ResearchMode = 'direct' | 'delegated'

/** Canonical result shared by programmatic and tool callers. */
export interface ResearchResult {
  readonly title: string
  readonly report: string
  readonly sources: ResearchSource[]
  readonly status: ResearchStatus
  readonly error?: string
  readonly metadata: {
    readonly startedAt: string
    readonly completedAt: string
    readonly mode: ResearchMode
    /** Provider-defined implementation id. */
    readonly provider: string
  }
}

/** One published, caller-owned research operation. */
export interface ResearchRun {
  readonly id: string
  /** Settles with a domain result, including cancellation or post-publication failure. */
  readonly result: Promise<ResearchResult>
  /** Request cooperative cancellation without releasing ownership. */
  cancel(reason?: string): void
  /** Cancel remaining work, reach quiescence, and release the owned DSH run. */
  dispose(): Promise<void>
}
