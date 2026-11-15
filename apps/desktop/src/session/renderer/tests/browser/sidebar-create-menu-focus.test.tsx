/**
 * The sidebar's 「+」 menu, opened from the keyboard and closed with Esc, gives focus back to the 「+」 (fe-continuity B2).
 * Real Chromium: Base UI's focus return runs on the popup's own close, which jsdom does not reproduce.
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ locale: 'en-US', translate: (key: string) => key }) }))
vi.mock('@/lib/sidebarChatsBridge', () => ({ requestShellChatAction: () => {}, useSidebarNotificationsOpen: () => false, useProductTourOnScreen: () => false }))
vi.mock('@renderer/features/sidebar/add-project-menu-items', () => ({ AddProjectMenuItems: () => null }))

const { SidebarOneListTop } = await import('@renderer/features/sidebar/sidebar-one-list-chrome')

let root: Root | null = null
afterEach(() => { root?.unmount(); root = null })

test('Esc closes the 「+」 menu and focus is back on the 「+」', async () => {
  const host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<SidebarOneListTop collapsed={false} onCreateAgent={() => {}} />)
  const plus = page.getByTestId('sidebar-create-menu')
  await expect.element(plus).toBeVisible()
  ;(plus.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('menu')).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(plus.element()))
})
