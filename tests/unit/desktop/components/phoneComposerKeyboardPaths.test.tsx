// @vitest-environment jsdom
import { requestGroupAgentCreation } from '@/lib/uiEvents'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AttachmentAdapter, type PendingAttachment, type CompleteAttachment, type ThreadMessage } from '../../../../apps/desktop/node_modules/@assistant-ui/react'
import { Thread } from '@/components/assistant-ui/thread.aui'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { DevicesContext, useDevicesStore } from '@/store/devicesContext'
import { PhoneGroupAgentCreation } from '@/mobile/chat/PhoneNewTask'
import * as rpc from '@/components/session-watch/sessionpage-rpc'
import { clickElement, createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { runInAction } from 'mobx'
import { groupFoldersStore } from '@/session/renderer/features/folders/group-folders-store'

vi.mock('@renderer/features/settings/subscriptions/ensure-agent-home', () => ({
  ensureAgentHomeImported: async () => undefined,
}))

// The task folder card lists this group's folders from the account's record (groupFoldersStore); 'machine' has one.
beforeEach(() => runInAction(() => {
  groupFoldersStore.account = [{ chatId: 'chat', name: 'Project', archived: false, activeAt: '2026-01-01T00:00:00.000Z', folders: [
    { deviceId: 'machine', folderId: 'workspace', path: '/project', position: 1, attachedAt: null, removalRequestedAt: null },
  ] }]
  groupFoldersStore.status = 'ready'
}))
afterEach(() => groupFoldersStore.clear())

let harness: ReturnType<typeof createReactHarness>
let surface: HTMLElement
const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
const scrollTo = Element.prototype.scrollTo
const input = () => surface.querySelector<HTMLElement>('[contenteditable="true"]')!
const send = () => surface.querySelector<HTMLButtonElement>(`[data-slot="composer-bar"] button[aria-label="${translateSessionMessage('composer.sendMessage')}"]`)!
const file = () => new File(['notes'], 'keyboard-notes.txt', { type: 'text/plain' })
const attachmentAdapter: AttachmentAdapter = {
  accept: 'text/plain',
  async add({ file }: { file: File }): Promise<PendingAttachment> { return { id: 'notes', name: file.name, type: 'file', file, contentType: file.type, status: { type: 'requires-action', reason: 'composer-send' } } },
  async send(attachment: PendingAttachment): Promise<CompleteAttachment> { return { ...attachment, status: { type: 'complete' }, content: [{ type: 'text', text: 'attached notes' }] } },
  async remove() {},
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  Element.prototype.scrollTo = () => undefined
  harness = createReactHarness()
  surface = harness.container
})
afterEach(() => {
  harness.cleanup()
  Object.defineProperty(window, 'innerWidth', originalWidth)
  Element.prototype.scrollTo = scrollTo
})

async function mount(kind: 'group' | 'dm' | 'agent' | 'task') {
  const delivered = vi.fn(async () => {})
  const attached = vi.fn(async () => {})
  const created = vi.spyOn(rpc, 'createSession').mockResolvedValue({ conversationId: 'session', projectId: 'project', title: 'Task', taskMessageId: 'card' })
  vi.spyOn(rpc, 'fetchCreateOptions').mockResolvedValue({ projects: [], lastUsed: null, harnesses: [
    { id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['full-access'] },
  ] })
  vi.spyOn(rpc, 'fetchCreateModels').mockResolvedValue({ harness: 'codex', transport: 'acp', models: [], efforts: [], selected: null, selectedEffort: null, harnessState: 'unknown', harnessReason: null, guguReason: null })
  function Agent() {
    const runtime = useExternalStoreRuntime<ThreadMessage>({ messages: [], onNew: delivered, adapters: { attachments: attachmentAdapter } })
    return <AssistantRuntimeProvider runtime={runtime}><Thread autoFocus={false} submitOnEnter={false} /></AssistantRuntimeProvider>
  }
  function Chat() {
    const base = useDevicesStore()
    return <DevicesContext.Provider value={{ ...base, devices: [device('machine', [], { projects: [{
      localProjectId: 'project', name: 'Project', rootPath: '/project', createdAt: '2026-10-26T00:00:00Z', chatId: 'chat',
      folders: [{ workspaceId: 'workspace', kind: 'root', path: '/project', attachedAt: null }],
    }] })] }}><ChatMessageComposer chatId="chat" isGroupChat={kind !== 'dm'} onSend={delivered} onSendAttachments={attached} />
      {kind === 'task' && <PhoneGroupAgentCreation chatId="chat" name="Project" />}
    </DevicesContext.Provider>
  }
  if (kind === 'task') await import('@/mobile/agent-watch/CreateSessionPage')
  await renderWithAppProviders(harness, kind === 'agent' ? <Agent /> : <Chat />)
  if (kind === 'task') {
    await act(async () => { requestGroupAgentCreation('chat') })
    surface = document.querySelector<HTMLElement>('[data-testid="phone-group-agent-sheet"]')!
    await clickElement(surface.querySelector<HTMLElement>('[data-testid="agent-watch-create-folder"]')!)
    await clickElement(document.querySelector<HTMLElement>('[data-testid="phone-task-folder-card"] [data-testid="project-folder-paper"]')!)
  }
  return { delivered, attached, created }
}

describe('phone keyboard across the real composer hosts', () => {
  for (const kind of ['group', 'dm', 'agent', 'task'] as const) {
    // Attachment placement and submission from the shared creation composer is covered by its browser tests.
    const methods = kind === 'task' ? ['button', 'enter'] as const : ['button', 'enter', 'attachment'] as const
    it.each(methods)(`${kind}: %s follows the phone keyboard contract`, async (method) => {
      const { delivered, attached, created } = await mount(kind)
      await act(async () => { writeComposer(input(), 'keyboard check') })
      if (method === 'attachment') {
        const picker = harness.container.querySelector<HTMLInputElement>('input[type="file"]')!
        Object.defineProperty(picker, 'files', { configurable: true, value: [file()] })
        await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
        expect(harness.container.querySelector('[data-slot="composer-attachment"]')).not.toBeNull()
      }
      await act(async () => { input().focus() })
      expect(document.activeElement).toBe(input())
      const blurred = vi.fn()
      input().addEventListener('blur', blurred)
      await act(async () => {
        if (method === 'enter') input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        else send().click() // DOM click deliberately does not move focus to the button.
      })
      if (method === 'enter') {
        expect(delivered).not.toHaveBeenCalled()
        expect(created).not.toHaveBeenCalled()
        expect(blurred).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(input())
        return
      }
      // #2581 Text sent with files rides on them: one send, no text message of its own.
      const filesCarryText = method === 'attachment' && kind !== 'agent'
      expect(kind === 'task' ? created : filesCarryText ? attached : delivered).toHaveBeenCalledTimes(1)
      if (filesCarryText) {
        expect(delivered).not.toHaveBeenCalled()
        expect(attached).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ caption: 'keyboard check' }))
      }
      expect(blurred).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(document.body)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
      expect(document.activeElement).toBe(document.body)
    })
  }
})
