import { describe, expect, it } from 'vitest'
import { extractSources, resultTitle } from '../src/result.js'

describe('research result normalization', () => {
  it('extracts titled and bare HTTP sources without duplicates or fragments', () => {
    expect(
      extractSources(`
# Answer

See [DSH](https://github.com/deepseek-ai/deepseek-harness#readme) and
https://example.com/paper.pdf. The same [repository](https://github.com/deepseek-ai/deepseek-harness) appears twice.
`),
    ).toEqual([
      { url: 'https://github.com/deepseek-ai/deepseek-harness', title: 'DSH' },
      { url: 'https://example.com/paper.pdf' },
    ])
  })

  it('removes trailing Markdown code delimiters from bare URLs', () => {
    expect(extractSources('Run `git clone https://github.com/example/project.git` first.')).toEqual(
      [{ url: 'https://github.com/example/project.git' }],
    )
  })

  it('stops bare URLs before adjacent CJK prose punctuation', () => {
    expect(
      extractSources(
        '待核实路径为 https://raw.githubusercontent.com/example/project/main/package.json，该路径尚未读取。',
      ),
    ).toEqual([{ url: 'https://raw.githubusercontent.com/example/project/main/package.json' }])
  })

  it('takes the first h1 as the report title and otherwise uses the question', () => {
    expect(resultTitle('# A focused title\n\nBody', 'Fallback?')).toBe('A focused title')
    expect(resultTitle('Body only', 'Fallback?')).toBe('Fallback?')
  })
})
