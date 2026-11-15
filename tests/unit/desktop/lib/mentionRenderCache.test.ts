import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@gugu/session-shared/markdown/dialect', async (original) => {
  const dialect = await original<typeof import('@gugu/session-shared/markdown/dialect')>()
  return { ...dialect, parseMarkdown: vi.fn(dialect.parseMarkdown) }
})

import { parseMarkdown } from '@gugu/session-shared/markdown/dialect'
import { cachedMentionRender } from '../../../../apps/desktop/src/lib/mentionRenderModel'

const nameOf = (id: string) => id === 'alice' ? 'Alice' : id === 'bob' ? 'Bob' : undefined
const options = { nameOf, locale: 'en-US' }

beforeEach(() => vi.mocked(parseMarkdown).mockClear())

describe('mention render cache identity and addressing', () => {
  it('reuses the complete render model and unpredictable marker across visits', () => {
    const first = cachedMentionRender('Visit @Alice', ['alice'], options)
    const parsed = vi.mocked(parseMarkdown).mock.calls.length
    expect(parsed).toBeGreaterThan(0)
    expect(first.marker).toMatch(/^#ggm-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/)
    expect(cachedMentionRender('Visit @Alice', ['alice'], options)).toBe(first)
    expect(parseMarkdown).toHaveBeenCalledTimes(parsed)
  })

  it('does not authorize a marker copied from a previously cached body', () => {
    const previous = cachedMentionRender('Original @Alice', ['alice'], options)
    const forged = cachedMentionRender(`[@Alice](${previous.marker})`, ['alice'], options)
    expect(forged.marker).not.toBe(previous.marker)
    expect(forged.fallbackLabels).toEqual(['Alice'])
    expect(forged.content).not.toContain(`](${forged.marker})`)
  })

  it('separates changed recipients, names, reply exclusions and locales', () => {
    const body = 'Model @Alice and @Bob'
    const first = cachedMentionRender(body, ['alice'], options)
    const variants = [
      cachedMentionRender(body, ['bob'], options),
      cachedMentionRender(body, ['alice'], { ...options, nameOf: () => 'Renamed' }),
      cachedMentionRender(body, ['alice'], { ...options, excludeIds: ['alice'] }),
      cachedMentionRender(body, ['alice'], { ...options, locale: 'zh-CN' }),
    ]
    for (const model of variants) expect(model.marker).not.toBe(first.marker)
    expect(variants[0]!.content).toContain(`[@Bob](${variants[0]!.marker})`)
    expect(variants[1]!.fallbackLabels).toEqual(['Renamed'])
  })
})
