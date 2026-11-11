import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import zh from '../../../../apps/desktop/src/i18n/locales/zh-CN/messaging'
import en from '../../../../apps/desktop/src/i18n/locales/en-US/messaging'
import { messageActionItems } from '../../../../apps/desktop/src/components/chat/messageActionItems'

/** Resolves `message.actions.*` keys against one locale file, the way the menu reads them. */
const translator = (locale: object) =>
  ((key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], locale)) as unknown as TFunction<'messaging'>

const noop = () => {}

describe('the task timeline menu on a message (owner 2026-11-12: 「复制」「评论」, copy first)', () => {
  it('a selection offers 复制 then 评论', () => {
    const items = messageActionItems({ isRetracted: false, content: 'text', hasSelection: true, onCopy: noop, onQuoteToComposer: noop }, translator(zh))
    expect(items.map((item) => item.label)).toEqual(['复制', '评论'])
  })

  it('the whole message offers the same two, in the same order', () => {
    const items = messageActionItems({ isRetracted: false, content: 'text', onCopy: noop, onQuoteToComposer: noop }, translator(zh))
    expect(items.map((item) => item.label)).toEqual(['复制', '评论'])
  })

  it('English reads Copy then Comment', () => {
    const items = messageActionItems({ isRetracted: false, content: 'text', hasSelection: true, onCopy: noop, onQuoteToComposer: noop }, translator(en))
    expect(items.map((item) => item.label)).toEqual(['Copy', 'Comment'])
  })
})
