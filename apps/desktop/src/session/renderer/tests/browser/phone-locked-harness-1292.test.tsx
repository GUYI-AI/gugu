import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SessionConversation } from '@/components/session-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/components/session-watch/agent-watch-store'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import {
  createReactHarness,
  renderWithAppProviders
} from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
import { i18n } from '@/i18n'
import '@/i18n/registerMessagingCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

const fixture = vi.hoisted(() => ({ modelName: '咕咕 GPT-6 Luna' }))

vi.mock('@gugu/core/cloud/config', async (original) => ({
  ...(await original<object>()),
  getSupabaseUrl: () => 'http://supabase.test.local',
  getSupabaseAnonKey: () => 'test-anon-key'
}))
vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({ chatView: 'double' }) } })
vi.mock('@/components/chat/useConversationOptions', () => ({
  useConversationOptions: () => {
    const models = composerModelOptions(
      {},
      [
        {
          id: 'gpt-6-luna',
          displayName: fixture.modelName,
          protocol: 'openai-chat-completions',
          creditMultiplier: 1,
          contextWindow: 1000000,
          reasoningEfforts: null
        }
      ],
      { ownTierLabel: 'Codex', icon: modelProviderIcon }
    )
    return {
      props: {
        modelOptions: models,
        selectedModel: Object.keys(models!)[0],
        permissionModeOptions: { full: { name: '完全访问', destructive: true } },
        selectedPermissionMode: 'full'
      },
      confirmation: null,
      steers: false
    }
  }
}))
let harness: ReturnType<typeof createReactHarness>
afterEach(() => {
  fixture.modelName = '咕咕 GPT-6 Luna'
  harness?.cleanup()
  document.body.replaceChildren()
  delete document.documentElement.dataset.theme
})
const out = '__screenshots__/acceptance1292'

it.each([false, true])(
  '1292 phone SessionConversation keeps its locked harness beside the model (working=%s)',
  async (working) => {
    await i18n.changeLanguage('zh-CN')
    await page.viewport(390, 844)
    document.documentElement.dataset.theme = 'light'
    harness = createReactHarness()
    harness.container.setAttribute('data-phone-shell', '')
    harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
    await renderWithAppProviders(
      harness,
      <SessionConversation
        timeline={emptyAgentWatchTimeline()}
        deviceId="device"
        sessionId="acceptance-1292"
        agentName="Codex"
        harness="codex"
        nativeRecord
        sessionRuntime="acp"
        respondingItemId={null}
        onRespond={vi.fn()}
        onSend={vi.fn()}
        pendingSends={[]}
        sending={false}
        agentWorking={working}
        onStop={vi.fn()}
        stopping={false}
        onLoadOlder={vi.fn()}
      />,
      { contacts: {} }
    )
    await until(
      'phone composer model',
      () => !!harness.container.querySelector('[data-testid="composer-model-trigger"]')
    )
    await new Promise((r) => setTimeout(r, 600))
    const locked = harness.container.querySelector<HTMLButtonElement>(
      'button[disabled][aria-label*="Codex"]'
    )!
    const model = harness.container.querySelector('[data-testid="composer-model-trigger"]')!
    const attachment = harness.container.querySelector<HTMLButtonElement>('[data-phone-attachment]')!
    const editor = harness.container.querySelector<HTMLElement>('[contenteditable]')!
    expect(attachment).not.toBeNull()
    expect(attachment.getBoundingClientRect().width).toBe(44)
    expect(attachment.getBoundingClientRect().right).toBeLessThanOrEqual(editor.getBoundingClientRect().left)
    expect(harness.container.querySelector(working ? 'button[aria-label="停止生成"]' : 'button[aria-label="发送消息"]')).not.toBeNull()
    ;(editor as HTMLElement & { editor: { commands: { setContent: (html: string) => void } } }).editor.commands.setContent('<p>第一行</p><p>第二行</p>')
    await until('attachment moves to the right of the two-line editor', () => attachment.getBoundingClientRect().left >= editor.getBoundingClientRect().right)
    expect(attachment.getBoundingClientRect().left).toBeGreaterThanOrEqual(editor.getBoundingClientRect().right)
    const chooseFile = vi.spyOn(harness.container.querySelector<HTMLInputElement>('input[type="file"]')!, 'click').mockImplementation(() => {})
    await userEvent.click(attachment)
    expect(chooseFile).toHaveBeenCalledOnce()
    expect(locked).not.toBeNull()
    expect(locked.getBoundingClientRect().width).toBeGreaterThan(0)
    expect(getComputedStyle(locked).opacity).toBe('1')
    expect(locked.getBoundingClientRect().right).toBeLessThanOrEqual(
      model.getBoundingClientRect().left
    )
    expect(
      Math.abs(locked.getBoundingClientRect().y - model.getBoundingClientRect().y)
    ).toBeLessThan(8)
    const send = harness.container.querySelector<HTMLButtonElement>(
      'button[aria-label="发送消息"]'
    )!
    expect(send).not.toBeNull()
    expect(
      harness.container.querySelectorAll(
        '[data-slot="composer-actions-end"] > button:not([data-composer-locked-agent])'
      )
    ).toHaveLength(1)
    expect(locked.hasAttribute('data-composer-locked-agent')).toBe(true)
    expect(
      locked.getBoundingClientRect().bottom <= send.getBoundingClientRect().top ||
        locked.getBoundingClientRect().right <= send.getBoundingClientRect().left
    ).toBe(true)
    const permission = harness.container
      .querySelector('[data-slot="composer-permission-mode"]')!
      .closest('button')!
    expect(permission.getBoundingClientRect().right).toBeLessThanOrEqual(
      locked.getBoundingClientRect().left
    )
    expect(model.querySelector('[role="img"]')?.getBoundingClientRect().width ?? 0).toBe(0)
    await page.screenshot({
      path: `${out}/${working ? 'phone-session-working' : 'phone-session-component'}.png`
    })
  }
)

it.each([false, true])(
  '1292 ordinary phone composer keeps attachment and send inside its capsule (group=%s)',
  async (group) => {
    await i18n.changeLanguage('zh-CN')
    await page.viewport(390, 844)
    document.documentElement.dataset.theme = 'light'
    harness = createReactHarness()
    harness.container.setAttribute('data-phone-shell', '')
    harness.container.style.cssText = 'width:390px;margin-top:600px'
    await renderWithAppProviders(
      harness,
      <ChatMessageComposer
        chatId={group ? 'group-control' : 'dm-control'}
        currentUserId="owner"
        isGroupChat={group}
        onSend={vi.fn(async () => {})}
      />,
      { contacts: {} }
    )
    await until(
      'ordinary phone composer',
      () => !!harness.container.querySelector('[data-slot="composer-bar"]')
    )
    const bar = harness.container.querySelector('[data-slot="composer-bar"]')!
    const editor = harness.container.querySelector('[data-testid="chat-composer"]')!
    const send = harness.container.querySelector('button[aria-label="发送消息"]')!
    const attach = harness.container.querySelector('[data-slot="composer-actions-start"] > button')!
    expect(getComputedStyle(bar).gridTemplateColumns.split(' ')).toHaveLength(3)
    expect(harness.container.querySelector('[data-composer-locked-agent]')).toBeNull()
    expect(
      harness.container.querySelectorAll('[data-slot="composer-actions-end"] > button')
    ).toHaveLength(1)
    expect(attach.getBoundingClientRect().right).toBeLessThanOrEqual(
      editor.getBoundingClientRect().left
    )
    expect(editor.getBoundingClientRect().right).toBeLessThanOrEqual(
      send.getBoundingClientRect().left
    )
    await page.screenshot({
      path: `${out}/${group ? 'phone-group-control' : 'phone-dm-control'}.png`
    })
  }
)

it('keeps the phone group attachment tray for photos, camera and files', async () => {
  await i18n.changeLanguage('zh-CN')
  await page.viewport(390, 844)
  document.documentElement.dataset.theme = 'light'
  harness = createReactHarness()
  await renderWithAppProviders(harness, <div data-phone-shell="" style={{ padding: 16, marginTop: 600 }}>
    <ChatMessageComposer chatId="project-group" isGroupChat onSend={vi.fn()} />
  </div>, { contacts: {} })
  await userEvent.click(page.getByTestId('chat-composer-attach-menu'))
  await until('attachment entries appear', () => !!document.querySelector('[data-testid="chat-composer-attach-file"]'))
  expect(document.querySelector('[data-testid="chat-composer-attach-photos"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="chat-composer-attach-camera"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="chat-composer-attach-phone-new-task"]')).toBeNull()
  await page.screenshot({ path: `${out}/phone-attachment-tray.png` })
})

it('keeps the existing model menu in the phone sidebar row and omits the old harness row', async () => {
  await page.viewport(390, 960)
  await i18n.changeLanguage('zh-CN')
  harness = createReactHarness()
  harness.container.setAttribute('data-phone-shell', '')
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  await renderWithAppProviders(harness, <SessionConversation
    timeline={emptyAgentWatchTimeline()} deviceId="device" sessionId="single-row" agentName="Pi" harness="pi"
    nativeRecord sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()}
    pendingSends={[]} sending={false} agentWorking={false} onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()}
    composerControls={model => <div data-testid="single-phone-row">智能体{model}</div>}
  />, { contacts: {} })
  await until('the same model control moved into the new row', () => !!harness.container.querySelector('[data-testid="single-phone-row"] [data-testid="composer-model-trigger"]'))
  expect(harness.container.querySelector('[data-composer-locked-agent]')).toBeNull()
  expect(harness.container.querySelector('[data-slot="composer-actions-end"] [data-slot="composer-model"]')).toBeNull()
  expect(harness.container.querySelectorAll('[data-testid="composer-model-trigger"]')).toHaveLength(1)
  await page.getByTestId('composer-model-trigger').click()
  await until('the original model menu opens', () => harness.container.querySelector('[data-testid="composer-model-trigger"]')?.getAttribute('aria-expanded') === 'true')
})
