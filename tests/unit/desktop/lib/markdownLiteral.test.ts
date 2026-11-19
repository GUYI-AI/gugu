// @vitest-environment jsdom
// Names and titles the host writes into markdown (a file pill's label, a quote's sender, an @ mention, an image's alt) read
// back as exactly the name: `\[…\]` and `$…$` are math in gugu's dialect, so a name with brackets or dollars was drawn as
// a formula (a pill `fix [2] scroll` showed KaTeX). Judged through the whole render chain (documentToHtml) and the
// readers that take a label out of the source by pattern.
import { describe, expect, it } from 'vitest'
import { markdownLiteral, readMarkdownLiteral } from '@gugu/core/shared/markdownLiteral'
import { messageQuoteText, readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { pillCite, stringifyMention } from '../../../../packages/session-shared/src/markdown/mention-grammar'
import { documentToHtml } from '../../../../packages/session-chat-ui/src/core/markdown/to-html'
import { splitAttachmentMentions } from '../../../../packages/session-chat-ui/src/core/markdown/attachment-mentions'
import { conversationQuoteText } from '../../../../packages/session-chat-ui/src/state/conversation-quote-text'
import { injectBackedMentions } from '../../../../apps/desktop/src/lib/mentionMdast'
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText'

const NAMES = [
  '协作看板.board.json (a56e · fix [2] scroll)',
  'Bob [bot]',
  'a [x] b \\[y\\] c',
  'cost $5 and $x$',
  'back\\slash \\(not math\\)',
  'star *bold* _under_ `code` ~strike~ <tag> &amp; &#91;',
  'lone ] and [ and $$',
]

function rendered(markdown: string): HTMLElement {
  const element = document.createElement('div')
  element.innerHTML = documentToHtml(markdown, { trust: 'chat' })
  return element
}

describe('markdownLiteral', () => {
  it.each(NAMES)('a link and an image named %j draw that name, no math', (name) => {
    const link = rendered(`see [${markdownLiteral(name)}](https://example.com/a) here`)
    expect(link.querySelector('.katex, math')).toBeNull()
    expect(link.querySelector('a')?.textContent).toBe(name)
    const image = rendered(`![${markdownLiteral(name)}](https://example.com/a.png)`)
    expect(image.querySelector('.katex, math')).toBeNull()
    expect(image.textContent + (image.querySelector('img')?.getAttribute('alt') ?? '')).toContain(name)
  })

  it.each(NAMES)('a file pill named %j draws its label and reads back by pattern', (name) => {
    const { draft } = pillCite('', [{ label: name, target: 'gugu-file://f1' }])
    expect(draft).toBe(stringifyMention({ kind: 'file', label: name, target: 'gugu-file://f1' }))
    const html = rendered(draft)
    expect(html.querySelector('.katex, math')).toBeNull()
    expect(html.textContent).toContain(name)
    expect(conversationQuoteText(stringifyMention({ kind: 'file', label: name, target: '/tmp/a.txt' }))).toBe(name)
    expect(splitAttachmentMentions(`look ${stringifyMention({ kind: 'file', label: name, target: '/tmp/a.txt' })}`).attachments[0]?.name).toBe(name)
  })

  it.each(NAMES)('a quote from %j shows and reads back the sender', (name) => {
    const text = messageQuoteText({ kind: 'chat', chatId: '00000000-0000-4000-8000-000000000001', messageId: '00000000-0000-4000-8000-000000000002' }, 'hello', name)
    expect(rendered(text).querySelector('.katex, math')).toBeNull()
    expect(readMessageQuote(text)?.sender).toBe(name)
  })

  it.each(NAMES.slice(0, 4))('a chat row previews a pill named %j as its name', (name) => {
    expect(markdownPlainText(pillCite('', [{ label: name, target: 'gugu-file://f1' }]).draft)).toBe(`@${name}`)
  })

  it('an @ mention whose name has brackets stays a mention, no math', () => {
    const marker = '#gg-mention-test'
    const html = rendered(injectBackedMentions('hi @Bob [bot] there', ['Bob [bot]'], marker))
    expect(html.querySelector('.katex, math')).toBeNull()
    expect(html.querySelector('a')?.textContent).toBe('@Bob [bot]')
  })

  it('reads back what it wrote, and what older writers wrote', () => {
    for (const name of NAMES) expect(readMarkdownLiteral(markdownLiteral(name))).toBe(name)
    expect(readMarkdownLiteral('fix \\[2\\] a\\\\b')).toBe('fix [2] a\\b')
  })
})
