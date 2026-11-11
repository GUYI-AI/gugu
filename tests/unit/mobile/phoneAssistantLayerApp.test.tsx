// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createReactHarness, clickElement } from '../../support/testHarness'
import type { PhoneRoute } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'

/**
 * The phone's assistant layer with the trusted App in it: what the person asks of the App's page through the layer (the
 * recording bar's note, the 自定义 card) moves the layer and tells the page once; API 50's voice-note removal is asked
 * with the layer's own question.
 */

const state = vi.hoisted(() => ({ held: null as Record<string, unknown> | null, stuck: false, entry: { entry: 'app', extensionId: 'gugu-assistant', tabKind: 'gugu-assistant.panel', binding: 'main' } as Record<string, unknown> }))
vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.name ? `${key}:${String(values.name)}` : key }) }))
vi.mock('../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner', nickname: 'Ann' } }) }))
vi.mock('../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ writeDraft: vi.fn(), draftAttachments: {}, setDraftAttachments: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ updateAgentProfile: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/store/chatLineScope', () => ({ ChatLineScope: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantConversationProgress', () => ({ AssistantConversationProgress: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantComposerEntries', () => ({
  AssistantComposerEntries: ({ customize }: { customize?: { onOpen: () => void } }) => customize ? <button data-testid="customize-card" onClick={customize.onOpen}>customize</button> : null,
}))
vi.mock('../../../apps/desktop/src/components/assistant/useAssistantTyping', () => ({ useAssistantTyping: () => null }))
vi.mock('../../../apps/desktop/src/components/ChatAreaPanel', () => ({ ChatAreaPanel: ({ chrome }: { chrome: { composerHeader?: React.ReactNode } }) => <div data-testid="retained-chat">{chrome.composerHeader}</div> }))
vi.mock('../../../apps/desktop/src/components/chat/filePreviewHost', () => ({ FilePreviewHost: { Provider: ({ children }: { children: React.ReactNode }) => children } }))
vi.mock('../../../apps/desktop/src/lib/onScreenChat', () => ({ useReportChatOnScreen: (id: string | null) => id }))
vi.mock('../../../apps/desktop/src/lib/assistantSetupState', () => ({ useCustomizeCardOffered: () => true }))
vi.mock('../../../apps/desktop/src/lib/assistantTaskChat', () => ({ useOpenedAssistantTaskChat: () => null, showAssistantTaskChat: vi.fn() }))
vi.mock('../../../apps/desktop/src/components/ui/sheetStack', () => ({ useBackLayer: () => {} }))
vi.mock('../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span>avatar</span> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneMachine', () => ({ usePhoneMachine: () => ({ state: 'opening' }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneVoiceRuntime', () => ({ usePhoneVoiceNotes: () => ({ disabled: true, start: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneVoiceBar', () => ({
  PhoneVoiceBar: ({ open }: { open: (route: PhoneRoute) => void }) => <button data-testid="bar-open" onClick={() => open({ tab: 'memory', sub: 'voice:n1' })}>open note</button>,
}))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneIdeas', () => ({ PhoneIdeas: () => null }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneAssistantWorkLedger', () => ({ PhoneAssistantWorkLedger: () => null }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneAssistantCounts', () => ({ PhoneAssistantCountsSource: () => null }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneProfile', () => ({ PhoneProfile: () => <div>host screen</div> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneMemory', () => ({ PhoneMemory: () => <div>host screen</div> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneConfirmDialog', () => ({
  PhoneConfirmDialog: ({ open, title, onConfirm, onClose, testId }: { open: boolean; title: string; onConfirm: () => Promise<void>; onClose: () => void; testId: string }) => open
    ? <div data-testid={testId}><span data-testid="removal-title">{title}</span>
      <button data-testid="removal-yes" onClick={() => void onConfirm().then(onClose)}>yes</button><button data-testid="removal-no" onClick={onClose}>no</button></div>
    : null,
}))
vi.mock('../../../apps/desktop/src/components/appSlot/PhoneAppFrame', () => ({ PhoneAppFrame: () => <div data-testid="app-frame" /> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneAssistantEntry', () => ({ PHONE_ASSISTANT_LAYER_TAB: 'assistant-layer', usePhoneAssistantEntry: () => state.entry }))
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell', () => ({ ShellSlot: () => null }))
vi.mock('../../../apps/desktop/src/session/renderer/features/global-search/search-session', () => ({ searchInChat: vi.fn() }))
vi.mock('../../../apps/desktop/src/components/appSlot/phoneAssistantAppEnsure', () => ({ usePhoneAssistantAppStuck: () => state.stuck }))
// The App with the assistant App's id on this phone, as the layer reads it (D2: whose copy it is decides "stuck").
vi.mock('../../../apps/desktop/src/components/appSlot/phoneBindingPorts', () => ({ phoneInstalledApp: () => state.held }))

import { MobileAssistantApp } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import { phoneAssistantLayer, resetPhoneAssistantLayerForTest } from '../../../apps/desktop/src/components/appSlot/phoneAssistantLayer'
import type { AppSurfaceIntent } from '../../../apps/desktop/src/session/shared/extensions/unread-binding'

let h: ReturnType<typeof createReactHarness>
const find = (id: string) => h.container.ownerDocument.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const props = { chatId: 'dm', assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, ownerName: null,
  homeDeviceId: null, cloudDeviceId: null, home: null, visible: true, chatRequest: 0, onExit: vi.fn() }
let told: { intent: AppSurfaceIntent; section: string | undefined }[]
beforeEach(() => {
  resetPhoneAssistantLayerForTest()
  told = []
  phoneAssistantLayer.onIntent((intent) => told.push({ intent, section: phoneAssistantLayer.shown()?.section }))
  h = createReactHarness()
})
afterEach(() => h.cleanup())

it('opens the recording bar\'s note as the App\'s 记忆, told `voice-note` once, after the layer shows that section', async () => {
  await h.render(<MobileAssistantApp {...props} />)
  await clickElement(find('bar-open')!)
  expect(find('mobile-assistant-app')!.dataset.tab).toBe('memory')
  expect(find('mobile-assistant-app')!.dataset.sub).toBe('')
  expect(told).toEqual([{ intent: { kind: 'voice-note' }, section: 'memory' }])
  expect(phoneAssistantLayer.shown()).toMatchObject({ section: 'memory', hostPage: false })
})

it('opens the 自定义 card as the App\'s 资料, told `profile` once', async () => {
  await h.render(<MobileAssistantApp {...props} />)
  await clickElement(find('customize-card')!)
  expect(find('mobile-assistant-app')!.dataset.tab).toBe('profile')
  expect(told).toEqual([{ intent: { kind: 'profile' }, section: 'profile' }])
})

it('asks before a voice note goes (API 50 removeVoiceNote): yes and no answered, the question gone after', async () => {
  await h.render(<MobileAssistantApp {...props} />)
  let answer!: Promise<boolean>
  await act(async () => { answer = phoneAssistantLayer.actions()!.confirmRemoval({ kind: 'voice-note', title: 'Standup' }) })
  expect(find('removal-title')!.textContent).toBe('deleteTitle:Standup')
  await clickElement(find('removal-yes')!)
  expect(await answer).toBe(true)
  expect(find('mobile-assistant-voice-delete-dialog')).toBeNull()
  await act(async () => { answer = phoneAssistantLayer.actions()!.confirmRemoval({ kind: 'voice-note', title: null }) })
  expect(find('removal-title')!.textContent).toBe('deleteTitle:untitled')
  await clickElement(find('removal-no')!)
  expect(await answer).toBe(false)
})

it('tells nothing while the layer is not on screen', async () => {
  await h.render(<MobileAssistantApp {...props} visible={false} />)
  await clickElement(find('bar-open')!)
  expect(told).toEqual([])
})

it('before the App is in: 聊天 as ever, the sections say it is being prepared; the bar opens 记忆 and tells nothing', async () => {
  state.entry = { entry: 'built-in', reason: 'the Apps on this phone are not read yet' }
  try {
    await h.render(<MobileAssistantApp {...props} />)
    expect(find('retained-chat')).not.toBeNull()
    await clickElement(find('mobile-assistant-tab-today')!)
    expect(find('mobile-assistant-app-preparing')!.textContent).toContain('railEntry.preparing')
    expect(find('app-frame')).toBeNull()
    await clickElement(find('bar-open')!)
    expect(find('mobile-assistant-app')!.dataset.tab).toBe('memory')
    expect(find('mobile-assistant-app')!.dataset.sub).toBe('')
    expect(find('mobile-assistant-app-preparing')).not.toBeNull()
    expect(told).toEqual([])
    expect(phoneAssistantLayer.shown()).toBeNull()
    // Every try of the window failed: said once, in place of the waiting line (no toast, no button).
    state.stuck = true
    await h.render(<MobileAssistantApp {...props} />)
    await clickElement(find('mobile-assistant-tab-tasks')!)
    expect(find('mobile-assistant-app-preparing')!.dataset.stuck).toBe('true')
    expect(find('mobile-assistant-app-preparing')!.textContent).toContain('assistantRules.stuckBody')
  } finally {
    state.stuck = false
    state.entry = { entry: 'app', extensionId: 'gugu-assistant', tabKind: 'gugu-assistant.panel', binding: 'main' }
  }
})

// D2 (fix/assistant-app-untrusted-install): gugu's own market copy the phone does not trust gets the signed release put
// over it by the ensure step, so the sections say it is being prepared, not stuck. Only the person's own copy (from a chat,
// switched off) is left as it is, and said stuck. Control (the parent commit): any App holding the id was said stuck.
it('an untrusted copy holding the id: gugu\'s market copy is being replaced (preparing); the person\'s own is stuck', async () => {
  const { installedExtensionsStore } = await import('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
  const loaded = installedExtensionsStore.isLoaded
  state.entry = { entry: 'built-in', reason: 'not the trusted App' }
  const copy = { manifest: { id: 'gugu-assistant', version: '0.9.0' }, origin: 'market', marketSource: null, manifestDigest: 'd', activeVariant: 'upstream', enabled: true, mainTabKind: null }
  const stuckShown = async () => {
    await h.render(<MobileAssistantApp {...props} />)
    await clickElement(find('mobile-assistant-tab-today')!)
    return find('mobile-assistant-app-preparing')!.dataset.stuck
  }
  try {
    installedExtensionsStore.isLoaded = true
    state.held = copy
    expect(await stuckShown()).not.toBe('true')
    state.held = { ...copy, origin: 'attachment' }
    expect(await stuckShown()).toBe('true')
    state.held = { ...copy, enabled: false }
    expect(await stuckShown()).toBe('true')
  } finally {
    installedExtensionsStore.isLoaded = loaded
    state.held = null
    state.entry = { entry: 'app', extensionId: 'gugu-assistant', tabKind: 'gugu-assistant.panel', binding: 'main' }
  }
})
