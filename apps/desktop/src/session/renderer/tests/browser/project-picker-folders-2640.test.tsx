import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { runInAction } from 'mobx'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { setLocalePreference } from '@/i18n'
import type { FolderRecord } from '@shared/core/folders/folders'
import { groupFoldersStore } from '@renderer/features/folders/group-folders-store'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { ComposerProjectPicker } from '@renderer/features/sessions/composer-context-tray'
// Same theme layers as the real entry (see composer-model-menu-3249.test.tsx): without them the popup has no surface colours.
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

// #2640: every group in the new-task group picker has a › with its folders ("device · path"); a group whose folders are
// all on offline machines offers "pick a folder on <machine>…". Real Chromium + real Base UI menu + the real component; only
// the data seams (the group folder store, the device list) are fed fixtures.

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { placement: { entries: new Map() } },
  appState: { navigation: { currentViewId: 'home', viewParamsStore: {}, revalidate: () => {} } },
}))

const folder = (id: string, chatId: string, path: string, sort = 1): FolderRecord => ({
  id, path, chatId, sort, gitless: false, baseRef: null, attachedAt: null, branch: null, sessionIds: [], taskHome: false,
})

describe('project picker › folders (#2640)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    // A realistic window: the submenu opens to the right of the list, as in the app.
    await page.viewport(1100, 640)
    setLocalePreference('zh-CN')
    // The real entry sets the light theme on <html>; without it the foreground tokens fall back to faint greys.
    document.documentElement.dataset.theme = 'light'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.spyOn(remoteHostsStore, 'pickableMachineIds').mockReturnValue(['mac1-id', 'd22-id'])
    vi.spyOn(remoteHostsStore, 'device').mockImplementation((id: string) => ({
      id, label: id === 'mac1-id' ? 'mac1' : 'd22', hostKind: 'server', isOnline: id === 'mac1-id', lastSeenAt: null,
    }) as never)
    vi.spyOn(remoteHostsStore, 'connectionState').mockImplementation((id: string) => (id === 'mac1-id' ? 'connected' : 'offline') as never)

    runInAction(() => {
      groupFoldersStore.status = 'ready'
      // What the machines answered: this computer (two folders of gugu, one of memor) and mac1 (one more of gugu).
      groupFoldersStore.answers.set('', [
        folder('ws-1', 'chat-gugu', '/Users/apple/Documents/gugu'),
        folder('ws-2', 'chat-gugu', '/Users/apple/Desktop/projects/gugu-opendcai', 2),
        folder('ws-4', 'chat-memor', '/Users/apple/Desktop/projects/memor'),
      ])
      groupFoldersStore.answers.set('mac1-id', [folder('ws-3', 'chat-gugu', '/Users/apple/Documents/gugu-dev')])
      // The account's record: groups' names, and folders on a machine that is offline right now (d22).
      groupFoldersStore.account = [
        { chatId: 'chat-gugu', name: 'gugu', archived: false, activeAt: '2026-11-13T00:00:04.000Z', folders: [] },
        // Same name, its only folder on the offline d22: must be told apart from the one above.
        { chatId: 'chat-gugu-twin', name: 'gugu', archived: false, activeAt: '2026-11-13T00:00:03.000Z', folders: [
          { deviceId: 'd22-id', folderId: 'ws-9', path: '/srv/gugu-old', position: 1, attachedAt: null, removalRequestedAt: null },
        ] },
        { chatId: 'chat-offline', name: '两院财务', archived: false, activeAt: '2026-11-13T00:00:02.000Z', folders: [
          { deviceId: 'd22-id', folderId: 'ws-5', path: '/srv/finance', position: 1, attachedAt: null, removalRequestedAt: null },
        ] },
        { chatId: 'chat-memor', name: 'memor', archived: false, activeAt: '2026-11-13T00:00:01.000Z', folders: [] },
      ]
    })
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    groupFoldersStore.clear()
    delete document.documentElement.dataset.theme
    vi.restoreAllMocks()
  })

  const mount = async (onSelect: (id: string | undefined) => void = () => {}) => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionLocalizationProvider>
          <div style={{ height: 520, display: 'flex', alignItems: 'flex-end', padding: 24 }}>
            <ComposerProjectPicker selectedId={undefined} onSelect={onSelect} />
          </div>
        </SessionLocalizationProvider>
      </QueryClientProvider>,
    )
    await until('the picker trigger', () => document.body.querySelector('button') !== null)
    await userEvent.click(page.getByText('未选择群'))
    await until('four group rows', () => document.body.querySelectorAll('[data-testid="project-picker-item"]').length === 4)
  }

  const row = (chatId: string) => document.body.querySelector<HTMLElement>(`[data-testid="project-picker-item"][data-chat-id="${chatId}"]`)!

  it('a group with folders lists them as device · path; picking one selects the group', async () => {
    const onSelect = vi.fn()
    await mount(onSelect)
    await userEvent.hover(row('chat-gugu'))
    await until('three folder rows', () => document.body.querySelectorAll('[data-workspace-id]').length === 3)
    const labels = [...document.body.querySelectorAll('[data-workspace-id]')].map((item) => item.textContent)
    expect(labels[0]).toContain('本机')
    expect(labels[0]).toContain('/Documents/gugu')
    expect(labels[2]).toContain('mac1')
    await userEvent.click(document.body.querySelector<HTMLElement>('[data-workspace-id="ws-3"]')!)
    expect(onSelect).toHaveBeenCalledWith('chat-gugu')
  })

  it('two groups named gugu stay distinguishable by their first folder', async () => {
    await mount()
    expect(row('chat-gugu').textContent).toContain('/Documents/gugu')
    expect(row('chat-gugu-twin').textContent).toContain('/srv/gugu-old')
  })

  it('a group whose folders are only on an offline device lists that device greyed and offers to pick a folder', async () => {
    await mount()
    await userEvent.hover(row('chat-offline'))
    await until('the greyed folder row', () => document.body.querySelector('[data-workspace-id="ws-5"][data-disabled]') !== null)
    await until('pick-a-folder rows', () => document.body.querySelectorAll('[data-testid="project-pick-folder-on"]').length >= 1)
    const offers = [...document.body.querySelectorAll('[data-testid="project-pick-folder-on"]')].map((item) => item.textContent)
    expect(offers[0]).toContain('在本机上选择文件夹')
  })
})
