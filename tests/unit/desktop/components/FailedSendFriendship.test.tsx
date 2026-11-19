// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FailedSendStatus } from '../../../../apps/desktop/src/components/chat/FailedSendStatus'
import { createReactHarness } from '../../../support/testHarness'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'

let ui: ReturnType<typeof createReactHarness>
beforeEach(() => { setLocalePreference('zh-CN'); ui = createReactHarness() })
afterEach(() => ui.cleanup())
it('explains an asynchronous server refusal in the existing failed-row menu', async () => {
  await ui.render(<FailedSendStatus reason="dm_friendship_required" onDiscard={vi.fn()} />)
  const trigger = ui.container.querySelector('[data-testid="message-send-failed"]')!
  expect(trigger.getAttribute('title')).toBe('请先添加对方为好友，再发送消息。')
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(document.body.textContent).toContain('请先添加对方为好友，再发送消息。')
  expect(document.body.textContent).not.toContain('dm_friendship_required')
})
