import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { PhoneComposerControl, PhoneComposerControlRow } from '@/mobile/composer/PhoneComposerControls'
import { RunningBarSlot, RunningTokenBar } from '@/components/RunningTokenBar'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); document.documentElement.removeAttribute('data-phone-shell') })
it.each([true])('group=%s: the input composer menu bar collapses fully without moving or replacing the input', async group => {
  await page.viewport(390, 844); setLocalePreference('zh-CN'); document.documentElement.dataset.theme = 'dark'; document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column' })
  const tokens = Array.from({ length: 12 }, (_, i) => ({ id: `fixture-${i}`, name: `正在检查图片的智能体 ${i}`, avatarUrl: null, avatarSeed: `fixture-${i}`, stateKey: 'running' as const, toolCount: 0, lastActiveAt: null }))
  await renderWithAppProviders(harness, <LocalizationProvider>
    <div data-testid="message-viewport" style={{ flex: '1', minHeight: 0, overflow: 'auto' }}><div style={{ height: 1500 }} /><img alt="last test image" width="280" height="180" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='280' height='180'%3E%3Crect width='280' height='180' fill='blue'/%3E%3C/svg%3E" /></div>
    <ChatBottomDock reserve={false} above={group ? <RunningBarSlot><RunningTokenBar tokens={tokens} previewChatId={null} /></RunningBarSlot> : undefined}>
      <div data-chat-composer="">
        {group && <PhoneComposerControlRow><PhoneComposerControl label="话题" testId="fixture-topics" onClick={() => {}} /></PhoneComposerControlRow>}
        <ChatMessageComposer chatId="menu-bar-test" currentUserId="owner" isGroupChat={group} onSend={vi.fn(async () => {})} onSendAttachments={vi.fn(async () => {})} />
      </div>
    </ChatBottomDock>
  </LocalizationProvider>)
  await until('real editor', () => !!harness!.container.querySelector('[contenteditable]'))
  const row = harness.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const input = harness.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const editor = input.querySelector<HTMLElement>('[contenteditable]')!
  editor.blur(); await until('idle menu', () => !row.hasAttribute('data-editing'))
  const initialTop = input.getBoundingClientRect().top
  const viewport = harness.container.querySelector<HTMLElement>('[data-testid="message-viewport"]')!
  const dock = harness.container.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
  // The dock floats over the messages like desktop: they run under the running row and the menu.
  expect(getComputedStyle(dock).position).toBe('absolute')
  expect(viewport.getBoundingClientRect().bottom).toBe(dock.getBoundingClientRect().bottom)
  expect(harness!.container.querySelector('[data-phone-attachment]')).not.toBeNull()
  const blur = vi.fn(), ended = vi.fn(); editor.addEventListener('blur', blur); editor.addEventListener('compositionend', ended)
  editor.focus(); editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }))
  await until('hidden menu', () => row.hasAttribute('data-editing'))
  await Promise.all(row.getAnimations().map(animation => animation.finished))
  expect(row.getBoundingClientRect().height).toBe(0)
  expect([getComputedStyle(row).paddingTop, getComputedStyle(row).paddingBottom, getComputedStyle(row).marginBottom]).toEqual(['0px', '0px', '0px'])
  expect(input.getBoundingClientRect().top).toBe(initialTop)
  expect(input.querySelector('[contenteditable]')).toBe(editor)
  expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  expect(viewport.getBoundingClientRect().bottom).toBe(dock.getBoundingClientRect().bottom)
  if (group) expect(harness.container.querySelector('[data-running-bar-slot]')!.getBoundingClientRect().bottom).toBeLessThan(viewport.getBoundingClientRect().bottom)
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })); editor.blur()
  await until('restored menu', () => !row.hasAttribute('data-editing'))
  expect(row.getBoundingClientRect().height).toBeGreaterThan(40)
  expect(input.getBoundingClientRect().top).toBe(initialTop)
})

// Owner 2026-11-16 13:29 supersedes the earlier attachment-only DM menu.
it('human direct messages keep the shared paperclip inside the input and open the existing panel', async () => {
  await page.viewport(390, 844); setLocalePreference('zh-CN'); document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><ChatBottomDock reserve={false}>
    <ChatMessageComposer chatId="human-direct" currentUserId="owner" onSend={vi.fn(async () => {})} onSendAttachments={vi.fn(async () => {})} />
  </ChatBottomDock></LocalizationProvider>)
  await until('actual direct composer', () => !!harness!.container.querySelector('[contenteditable]'))
  expect(harness.container.querySelector('[data-phone-composer-controls]')).toBeNull()
  const input = harness.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const attachment = harness!.container.querySelector<HTMLElement>('[data-phone-attachment]')!
  expect(input.querySelector('[contenteditable]')?.textContent).toBe('')
  expect(harness!.container.querySelector('[data-phone-editor-toggle]')).toBeNull()
  const clip = attachment.getBoundingClientRect()
  const box = input.getBoundingClientRect()
  expect(clip.left).toBeGreaterThanOrEqual(box.left); expect(clip.right).toBeLessThanOrEqual(box.right)
  expect(clip.top).toBeGreaterThanOrEqual(box.top); expect(clip.bottom).toBeLessThanOrEqual(box.bottom)
  await page.getByTestId('chat-composer-attach-menu').click()
  await expect.element(page.getByTestId('chat-composer-attach-panel')).toBeVisible()
  for (const name of ['photos', 'camera', 'file']) expect(harness.container.querySelector(`[data-testid="chat-composer-attach-${name}"]`)).not.toBeNull()
})
