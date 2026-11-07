import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@gugu/session-shared/markdown/dialect', async (original) => {
  const dialect = await original<typeof import('@gugu/session-shared/markdown/dialect')>()
  return { ...dialect, parseMarkdown: vi.fn(dialect.parseMarkdown) }
})

import { parseMarkdown } from '@gugu/session-shared/markdown/dialect'
import { buildMentionRender } from '../../../../apps/desktop/src/lib/mentionRenderModel'

const nameOf = (id: string) => id === 'alice' ? 'Alice' : id === 'bob' ? 'Bob' : undefined

beforeEach(() => vi.mocked(parseMarkdown).mockClear())

describe('conversation-switch mention work', () => {
  it('does not parse markdown to find backed highlights when no recipient exists', () => {
    const body = '# A long code-heavy message\n```ts\nconst value = 1\n```'
    expect(buildMentionRender(body, [], { nameOf, marker: '#ggm-no-recipient' })).toEqual({ content: body, fallbackLabels: [] })
    expect(parseMarkdown).not.toHaveBeenCalled()
  })

  it('does not parse an unchanged body without a routed token', () => {
    const body = 'A message addressed to Alice without spelling a mention.'
    expect(buildMentionRender(body, ['alice'], { nameOf, marker: '#ggm-no-token' })).toEqual({ content: body, fallbackLabels: ['Alice'] })
    expect(parseMarkdown).not.toHaveBeenCalled()
  })

})
