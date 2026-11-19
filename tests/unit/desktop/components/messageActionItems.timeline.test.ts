import type { TFunction } from 'i18next'
import { expect, it, vi } from 'vitest'
import { messageActionItems, type MessageActionTarget } from '../../../../apps/desktop/src/components/chat/messageActionItems'

const t = ((key: string) => key) as unknown as TFunction<'messaging'>
const fn = vi.fn()
const timeline: MessageActionTarget = { isRetracted: false, content: 'x', onQuoteToComposer: fn, onCopy: fn, onForkTask: fn }
const keys = (input: MessageActionTarget) => messageActionItems(input, t).map(item => item.key)
const label = (input: MessageActionTarget, key: string) => messageActionItems(input, t).find(item => item.key === key)?.label

it('puts copy first and the comment (quote into the composer) right after it, and says when a quote is of a selection', () => {
  // owner 2026-11-12: 「复制」放在「评论」前面.
  expect(keys({ ...timeline, onCopyLink: fn, onOpenLink: fn, onOpenFile: fn })).toEqual(['copy', 'quoteToComposer', 'copyLink', 'openLink', 'openFile', 'forkTask'])
  expect(label({ ...timeline, hasSelection: true }, 'quoteToComposer')).toBe('message.actions.quoteSelectionToComposer')
  expect(label(timeline, 'quoteToComposer')).toBe('message.actions.quoteToComposer')
})

it('leaves the chat menu in its own order and wording', () => {
  expect(label({ isRetracted: false, content: 'x', hasSelection: true, onCopy: fn }, 'copy')).toBe('message.actions.copy')
  expect(keys({ isRetracted: false, content: 'x', onCopy: fn, onCopyLink: fn, onOpenLink: fn, onDownload: fn })).toEqual(['copy', 'copyLink', 'openLink', 'download'])
})
