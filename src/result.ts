import type { ResearchMode, ResearchResult, ResearchSource, ResearchStatus } from './types.js'

function cleanUrl(candidate: string): string | undefined {
  let trimmed = candidate.trim().replace(/[.,;:!?}>]+$/u, '')
  while (trimmed.endsWith(']')) trimmed = trimmed.slice(0, -1)
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/** Extract and de-duplicate Markdown and bare HTTP(S) links from a report. */
export function extractSources(markdown: string): ResearchSource[] {
  const sources = new Map<string, ResearchSource>()
  const markdownLinks = /\x5b([^\x5d]+)\x5d\((https?:\/\/[^\s)]+)\)/giu

  for (const match of markdown.matchAll(markdownLinks)) {
    const url = match[2] === undefined ? undefined : cleanUrl(match[2])
    if (url === undefined || sources.has(url)) continue
    const title = match[1]?.trim()
    sources.set(url, title ? { url, title } : { url })
  }

  const bareLinks = /https?:\/\/[^\s<>()]+/giu
  for (const match of markdown.matchAll(bareLinks)) {
    if (
      match.index !== undefined &&
      markdown.slice(Math.max(0, match.index - 2), match.index) === ']('
    ) {
      continue
    }
    const url = cleanUrl(match[0])
    if (url !== undefined && !sources.has(url)) sources.set(url, { url })
  }

  return [...sources.values()]
}

/** Use the answer heading when present, otherwise fall back to the question. */
export function resultTitle(report: string, question: string): string {
  const heading = report.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim()
  return heading || question.trim()
}

export interface MaterializeResultOptions {
  readonly requestQuestion: string
  readonly report: string
  readonly status: ResearchStatus
  readonly mode: ResearchMode
  readonly provider: string
  readonly startedAt: string
  readonly error?: string
}

/** Materialize the shared result shape from either DSH execution path. */
export function materializeResult(options: MaterializeResultOptions): ResearchResult {
  const report = options.report.trim()
  return {
    title: resultTitle(report, options.requestQuestion),
    report,
    sources: extractSources(report),
    status: options.status,
    ...(options.error === undefined ? {} : { error: options.error }),
    metadata: {
      startedAt: options.startedAt,
      completedAt: new Date().toISOString(),
      mode: options.mode,
      provider: options.provider,
    },
  }
}

/** Convert an unknown post-publication exception into a stable failed result. */
export function failedResult(
  question: string,
  mode: ResearchMode,
  provider: string,
  startedAt: string,
  error: unknown,
  cancelled: boolean,
): ResearchResult {
  return materializeResult({
    requestQuestion: question,
    report: '',
    status: cancelled ? 'cancelled' : 'failed',
    mode,
    provider,
    startedAt,
    error: error instanceof Error ? error.message : String(error),
  })
}
