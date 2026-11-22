/**
 * #2548 a standalone task without a 咕咕 identity is a row of the one list (OneListTaskRow). Right click = its session
 * menu (session-menu.ts entry 'one-list-task'): rename, archive and copy id, archive through the one archive flow, on
 * the row's own task (not the one the main area shows).
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

const requestArchiveSession = vi.hoisted(() => vi.fn())
const withMountedSession = vi.hoisted(() => vi.fn((_projectId: string, _sessionId: string, run: () => void) => run()))

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: { currentViewId: 'session', viewParamsStore: { session: { projectId: 'workspace', sessionId: 'task-other' } } },
  },
  sidebarStore: {
    placement: {
      nodeById: new Map([['task-1', { item: { title: 'hey friend!', isPinned: false, time: Date.parse('2026-09-07T07:03:22Z'), presentation: null } }]]),
    },
  },
}))
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({ requestArchiveSession }))
vi.mock('@renderer/features/sidebar/with-mounted-session', () => ({ withMountedSession }))
vi.mock('@renderer/features/sidebar/sidebar-session-item', () => ({ openSidebarSession: () => undefined }))
vi.mock('@/components/session-watch/StatusGlyph', () => ({ SessionAvatar: () => <span /> }))

import { OneListTaskRow } from '@renderer/features/sidebar/one-list-task-row'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  host.style.width = '300px'
  document.body.append(host)
  root = createRoot(host)
  requestArchiveSession.mockClear()
  withMountedSession.mockClear()
})

afterEach(() => {
  root.unmount()
  host.remove()
})

async function openMenu(): Promise<HTMLElement[]> {
  root.render(
    <SessionLocalizationProvider>
      <OneListTaskRow projectId="workspace" sessionId="task-1" />
    </SessionLocalizationProvider>
  )
  await until('task row mounted', () => host.querySelector('[data-task-row="task-1"]') !== null)
  host.querySelector<HTMLElement>('[data-task-row="task-1"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  await until('context menu items render', () => document.querySelectorAll('[role="menuitem"]').length > 0)
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}

it('right click offers the session menu this row can act on: rename, archive, copy id', async () => {
  const items = await openMenu()
  expect(items.map((item) => item.dataset.testid)).toEqual([
    'one-list-task-menu-rename',
    'one-list-task-menu-archive',
    'one-list-task-menu-copy-id',
  ])
})

it('archive runs the one archive flow on this row\'s task, mounting it first', async () => {
  const items = await openMenu()
  await userEvent.click(items.find((item) => item.dataset.testid === 'one-list-task-menu-archive')!)
  expect(withMountedSession).toHaveBeenCalledWith('workspace', 'task-1', expect.any(Function))
  expect(requestArchiveSession).toHaveBeenCalledWith({ projectId: 'workspace', sessionId: 'task-1' })
  await until('menu closed', () => document.querySelectorAll('[role="menuitem"]').length === 0)
})
