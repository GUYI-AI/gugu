import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { usePhoneNewTask } from '@/mobile/chat/PhoneNewTask'
import { ComposerAttachButton } from '@/components/chat/ComposerAttachButton'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import {
  createReactHarness,
  renderWithAppProviders
} from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
import { i18n } from '@/i18n'
import { Zap } from '@/lib/icons'
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
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: { chatView: 'double' } })
}))
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
vi.mock('@/mobile/chat/phoneTaskFolders', () => ({
  taskFoldersOfChat: () => ({ memberIds: [], folders: [], homeOf: () => undefined })
}))
vi.mock('@/mobile/chat/usePhoneFolderAttach', () => ({
  usePhoneFolderAttach: () => ({ added: [], fresh: new Set(), picker: null })
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
      working ? 'button[aria-label="停止生成"]' : 'button[aria-label="发送消息"]'
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

it('a long model name gives way to the permission name, not the other way round', async () => {
  // Reported on a 360 px phone: 「完全访问」 lost the right half of 「问」 beside 「咕咕 DeepSeek V4 Pro Xhigh」.
  fixture.modelName = '咕咕 DeepSeek V4 Pro Xhigh Extended'
  await i18n.changeLanguage('zh-CN')
  await page.viewport(360, 800)
  document.documentElement.dataset.theme = 'light'
  harness = createReactHarness()
  harness.container.setAttribute('data-phone-shell', '')
  harness.container.style.cssText = 'height:760px;width:360px;display:flex;flex-direction:column'
  await renderWithAppProviders(
    harness,
    <SessionConversation
      timeline={emptyAgentWatchTimeline()}
      deviceId="device"
      sessionId="permission-name-width"
      agentName="Codex"
      harness="codex"
      nativeRecord
      sessionRuntime="acp"
      respondingItemId={null}
      onRespond={vi.fn()}
      onSend={vi.fn()}
      pendingSends={[]}
      sending={false}
      agentWorking={false}
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
  const name = harness.container.querySelector<HTMLElement>(
    '[data-slot="composer-permission-mode"] > span:last-child'
  )!
  expect(name.textContent).toBe('完全访问')
  // Every box between the name and its button clips: the name is whole only if each one holds it.
  for (
    let box: HTMLElement | null = name;
    box && box.tagName !== 'BUTTON';
    box = box.parentElement
  ) {
    expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(name.scrollWidth - 0.5)
  }
  const permission = name.closest('button')!
  const locked = harness.container.querySelector('[data-composer-locked-agent]')!
  const model = harness.container.querySelector<HTMLElement>(
    '[data-testid="composer-model-trigger"]'
  )!
  expect(permission.getBoundingClientRect().right).toBeLessThanOrEqual(
    locked.getBoundingClientRect().left
  )
  expect(locked.getBoundingClientRect().right).toBeLessThanOrEqual(
    model.getBoundingClientRect().left
  )
  expect(model.getBoundingClientRect().right).toBeLessThanOrEqual(
    harness.container.getBoundingClientRect().right
  )
  await page.screenshot({ path: `${out}/phone-long-model-name.png` })
})

it.each([false, true])(
  '1292 ordinary phone composer preserves its three-column layout (group=%s)',
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
    const editor = harness.container.querySelector('[data-slot="composer-input"]')!
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

it('1292 phone project attachment menu uses the real new-task action lightning', async () => {
  await i18n.changeLanguage('zh-CN')
  await page.viewport(390, 844)
  document.documentElement.dataset.theme = 'light'
  harness = createReactHarness()
  function Fixture() {
    const task = usePhoneNewTask({ chatId: 'project-group', enabled: true, clear: () => {} })
    return (
      <div data-phone-shell="" style={{ padding: 16, marginTop: 600 }}>
        <span hidden data-zap-control>
          <Zap size={16} />
        </span>
        <ComposerAttachButton
          actions={task.action ? [task.action] : []}
          disabled={false}
          mobile
          onPickFile={() => {}}
        />
      </div>
    )
  }
  await renderWithAppProviders(harness, <Fixture />, { contacts: {} })
  await userEvent.click(page.getByTestId('chat-composer-attach-menu'))
  await until(
    'real phone new-task action',
    () => !!document.querySelector('[data-testid="chat-composer-attach-phone-new-task"]')
  )
  const task = document.querySelector('[data-testid="chat-composer-attach-phone-new-task"]')!
  expect(task.textContent).toContain('新任务')
  expect(task.querySelector('svg')).not.toBeNull()
  expect(task.querySelector('svg')!.innerHTML).toBe(
    document.querySelector('[data-zap-control] svg')!.innerHTML
  )
  await page.screenshot({ path: `${out}/phone-task-menu-component.png` })
})
