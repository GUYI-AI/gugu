import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { runInAction } from 'mobx'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { setLocalePreference } from '@/i18n'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { machineRegistry } from '@renderer/lib/machine-routing'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { ComposerProjectPicker } from '@renderer/features/sessions/composer-context-tray'
// Same theme layers as the real entry (see composer-model-menu-3249.test.tsx): without them the popup has no surface colours.
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

// #2640: every project in the new-task project picker has a › with its folders ("device · path"); a project with no
// usable folder offers "pick a folder on <machine>…". Real Chromium + real Base UI menu + the real component; only the
// data seams (account project list, the folder reader, the device list) are fed fixtures.

const fixtures = vi.hoisted(() => ({
  folders: {} as Record<string, Array<{ workspaceId: string; projectId: string; kind: 'root' | 'attached'; path: string; deviceId: string | null; offline: boolean }>>,
}))

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { rowProjectIdOf: (id: string) => id, projectMembersOf: (id: string) => [id], placement: { entries: new Map() } },
  appState: { navigation: { currentViewId: 'home', viewParamsStore: {}, revalidate: () => {} } },
}))
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getGitRepositoryStore: () => undefined,
  getProjectStore: (projectId: string) => ({ id: projectId, name: projectId, data: { id: projectId, name: projectId, path: fixtures.folders[projectId]?.[0]?.path ?? '' } }),
  asMounted: () => undefined,
  mountedProjectData: () => null,
  projectDisplayName: (store: { name?: string } | undefined) => store?.name,
  projectViewKind: () => 'ready',
  getProjectManagerStore: () => ({ projects: new Map() }),
}))
vi.mock('@renderer/features/projects/components/project-picker-folders', () => ({
  useProjectPickerFolders: (rowId: string) => ({
    folders: (fixtures.folders[rowId] ?? []).map((folder) => ({ ...folder, branch: null, sessionIds: [], attachedAt: null })),
    readFailed: false,
    reading: false,
  }),
}))

const project = (chatId: string, name: string, bindings: AccountProject['bindings']): AccountProject => ({
  chatId, name, archived: false, activeAt: '2026-11-13T00:00:00.000Z', bindings,
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
    machineRegistry.register('mac1-id', ['p-gugu-mac1'])
    vi.spyOn(remoteHostsStore, 'pickableMachineIds').mockReturnValue(['mac1-id', 'd22-id'])
    vi.spyOn(remoteHostsStore, 'device').mockImplementation((id: string) => ({
      id, label: id === 'mac1-id' ? 'mac1' : 'd22', hostKind: 'server', isOnline: id === 'mac1-id', lastSeenAt: null,
    }) as never)
    vi.spyOn(remoteHostsStore, 'connectionState').mockImplementation((id: string) => (id === 'mac1-id' ? 'connected' : 'offline') as never)

    fixtures.folders = {
      // The project the person actually has: the same repo on this computer (two folders) and on mac1.
      'p-gugu': [
        { workspaceId: 'ws-1', projectId: 'p-gugu', kind: 'root', path: '/Users/apple/Documents/gugu', deviceId: null, offline: false },
        { workspaceId: 'ws-2', projectId: 'p-gugu', kind: 'attached', path: '/Users/apple/Desktop/projects/gugu-opendcai', deviceId: null, offline: false },
        { workspaceId: 'ws-3', projectId: 'p-gugu', kind: 'attached', path: '/Users/apple/Documents/gugu-dev', deviceId: 'mac1-id', offline: false },
      ],
      'p-memor': [{ workspaceId: 'ws-4', projectId: 'p-memor', kind: 'root', path: '/Users/apple/Desktop/projects/memor', deviceId: null, offline: false }],
    }
    runInAction(() => {
      accountProjectsStore.localDeviceId = 'this-computer'
      accountProjectsStore.status = 'ready'
      accountProjectsStore.list = [
        project('chat-gugu', 'gugu', [{ deviceId: 'this-computer', localProjectId: 'p-gugu' }, { deviceId: 'mac1-id', localProjectId: 'p-gugu-mac1' }]),
        // Same name, no folder anywhere (legacy zero-folder project): must be told apart from the one above.
        project('chat-gugu-empty', 'gugu', []),
        // A folder only on a device that is offline right now: not "no folder".
        project('chat-offline', '两院财务', [{ deviceId: 'd22-id', localProjectId: 'p-offline' }]),
        project('chat-memor', 'memor', [{ deviceId: 'this-computer', localProjectId: 'p-memor' }]),
      ]
      accountProjectsStore.attach({
        projects: new Map([['p-gugu', { createdAt: null }], ['p-gugu-mac1', { createdAt: null }], ['p-memor', { createdAt: null }]]) as never,
        machineOf: (id: string) => machineRegistry.machineOf(id) ?? null,
        connected: () => true,
      })
    })
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    machineRegistry.forgetMachine('mac1-id')
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
    await userEvent.click(page.getByText('未选择项目'))
    await until('four project rows', () => document.body.querySelectorAll('[data-testid="project-picker-item"]').length === 4)
  }

  const row = (chatId: string) => document.body.querySelector<HTMLElement>(`[data-testid="project-picker-item"][data-chat-id="${chatId}"]`)!

  it('a project with folders lists them as device · path; picking one selects the project', async () => {
    const onSelect = vi.fn()
    await mount(onSelect)
    await userEvent.hover(row('chat-gugu'))
    await until('three folder rows', () => document.body.querySelectorAll('[data-workspace-id]').length === 3)
    const labels = [...document.body.querySelectorAll('[data-workspace-id]')].map((item) => item.textContent)
    expect(labels[0]).toContain('这台电脑')
    expect(labels[0]).toContain('/Documents/gugu')
    expect(labels[2]).toContain('mac1')
    await userEvent.click(document.body.querySelector<HTMLElement>('[data-workspace-id="ws-3"]')!)
    expect(onSelect).toHaveBeenCalledWith('p-gugu')
  })

  it('two projects named gugu stay distinguishable, and an empty one says so and offers to pick a folder', async () => {
    await mount()
    // Row text, top level: the empty twin says "还没有文件夹", the other carries its path.
    expect(row('chat-gugu-empty').textContent).toContain('还没有文件夹')
    expect(row('chat-gugu').textContent).toContain('/Documents/gugu')
    await userEvent.hover(row('chat-gugu-empty'))
    await until('pick-a-folder rows', () => document.body.querySelectorAll('[data-testid="project-pick-folder-on"]').length >= 1)
    const offers = [...document.body.querySelectorAll('[data-testid="project-pick-folder-on"]')].map((item) => item.textContent)
    expect(offers[0]).toContain('在这台电脑上选文件夹')
  })

  it('a project whose folders are only on an offline device lists that device greyed, not "no folder"', async () => {
    await mount()
    expect(row('chat-offline').textContent).not.toContain('还没有文件夹')
    await userEvent.hover(row('chat-offline'))
    await until('the greyed device row', () => document.body.querySelector('[data-device-id="d22-id"][data-disabled]') !== null)
    expect(document.body.querySelector('[data-device-id="d22-id"][data-disabled]')?.textContent).toContain('暂不可用')
  })
})
