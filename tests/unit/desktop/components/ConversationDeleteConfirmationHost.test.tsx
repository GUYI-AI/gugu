// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { ConversationDeleteConfirmationHost } from '../../../../apps/desktop/src/components/chat/ConversationDeleteConfirmationHost'
import { requestConversationDeleteConfirmation } from '../../../../apps/desktop/src/lib/conversationDeleteConfirmation'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

it('confirms a phone list deletion without a mounted session page and defaults Agent removal to unchecked', async () => {
  await harness.render(createElement(ConversationDeleteConfirmationHost))
  let choice!: Promise<boolean | null>
  await act(async () => { choice = requestConversationDeleteConfirmation(new AbortController().signal, true) })
  const dialog = document.querySelector('[data-testid=conversation-delete-confirm]')!
  expect(dialog).toBeTruthy()
  expect(dialog.querySelector('[role=checkbox]')?.getAttribute('aria-checked')).toBe('false')
  await act(async () => { (dialog.querySelector('[data-testid=conversation-delete-submit]') as HTMLElement).click() })
  expect(await choice).toBe(false)
})

it('dismisses a pending choice on account loss without confirming deletion', async () => {
  await harness.render(createElement(ConversationDeleteConfirmationHost))
  const boundary = new AbortController()
  let choice!: Promise<boolean | null>
  await act(async () => { choice = requestConversationDeleteConfirmation(boundary.signal, false) })
  expect(document.querySelector('[role=checkbox]')).toBeNull()
  await act(async () => boundary.abort())
  expect(await choice).toBeNull()
  expect(document.querySelector('[data-testid=conversation-delete-confirm]')).toBeNull()
})
