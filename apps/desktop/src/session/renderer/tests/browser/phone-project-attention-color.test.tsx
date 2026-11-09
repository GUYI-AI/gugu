import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { PhoneProjectChatAvatar } from '@/mobile/partners/PhoneProjectChatAvatar'
import { chat, device } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-shell.css'
import '@/mobile/partners/partners.css'

vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [device('host', [], {
  projects: [{ localProjectId: 'project', chatId: 'project-chat', name: 'Test project', rootPath: '/project', createdAt: '2026-11-08T00:00:00Z', folders: [] }],
})] }) }))
vi.mock('@/hooks/useAgentDisplayStatus', () => ({ useAgentDisplayStatuses: () => ({}) }))
vi.mock('@/session/shared/remote-sessions/session-directory', async original => ({
  ...await original<typeof import('@/session/shared/remote-sessions/session-directory')>(),
  useLiveDeviceSessions: () => ({ host: { projects: [], cached: false, loading: false, error: null, sessions: [
    { conversationId: 'waiting', projectId: 'project', title: 'Test agent', status: { status: 'needs_user', detail: 'approval' }, runtime: 'acp', supported: true, unseen: true },
  ] } }),
}))

const cleanups: (() => void)[] = []
const oldTheme = document.documentElement.dataset.theme
const oldClasses = document.documentElement.className
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  document.documentElement.className = oldClasses
  if (oldTheme) document.documentElement.dataset.theme = oldTheme
  else delete document.documentElement.dataset.theme
})

it.each(['light', 'dark'] as const)('keeps the phone project waiting dot visible without a session theme in %s mode', async theme => {
  await page.viewport(390, 200)
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.remove('emlight', 'emdark')
  const host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;inset:0;background:var(--bg);color:var(--text-primary);padding:12px'
  const label = host.appendChild(document.createElement('div'))
  label.textContent = `测试环境渲染，未经真机验证，原因：无真机\n${import.meta.env.VITE_OWNER_CAPTURE_SHA ?? 'regression test'}`
  label.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:var(--font-caption) sans-serif;margin-bottom:20px'
  const mount = host.appendChild(document.createElement('div'))
  mount.setAttribute('data-phone-shell', '')
  const root = createRoot(mount)
  cleanups.push(() => { act(() => root.unmount()); host.remove() })
  await act(async () => { root.render(<PhoneProjectChatAvatar chat={chat({ id: 'project-chat', kind: 'group', member_user_ids: [] })} mobile><span>Project</span></PhoneProjectChatAvatar>) })
  await until('project waiting dot renders', () => !!host.querySelector('[data-testid="phone-project-waiting"]'))
  const dot = host.querySelector<HTMLElement>('[data-testid="phone-project-waiting"]')!
  const reference = host.appendChild(document.createElement('span'))
  reference.style.backgroundColor = 'var(--agent-tone-needs-user)'
  const phase = import.meta.env.VITE_OWNER_CAPTURE_PHASE
  if (phase) await page.screenshot({ element: host, path: `__screenshots__/owner-2245-${phase}-attention-${theme}.png` })
  expect(getComputedStyle(mount).getPropertyValue('--foreground-warning')).toBe('')
  expect(getComputedStyle(dot).backgroundColor).toBe(getComputedStyle(reference).backgroundColor)
  expect(getComputedStyle(dot).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(dot.getBoundingClientRect().width).toBe(8)
  expect(dot.getBoundingClientRect().height).toBe(8)
})
