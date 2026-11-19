import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { InSettingsPanelProvider, PageHeader, PageScopeProvider } from '@renderer/lib/components/page-header'

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { root.unmount(); host.remove() })

it('keeps the shell heading alone while preserving the inner page refresh action', async () => {
  const refresh = vi.fn()
  root.render(<><h2>Subscriptions</h2><InSettingsPanelProvider>
    <PageHeader title="My subscriptions" aside={<button onClick={refresh}>Refresh</button>} />
  </InSettingsPanelProvider></>)
  await userEvent.click(page.getByRole('button', { name: 'Refresh' }))
  expect(host.querySelectorAll('h2')).toHaveLength(1)
  expect(host.querySelector('h2')?.textContent).toBe('Subscriptions')
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('keeps the page title and refresh action when there is no settings shell', async () => {
  root.render(<PageHeader title="Subscriptions" aside={<button>Refresh</button>} />)
  await until('standalone page title is visible', () => host.querySelector('h2') !== null)
  expect(host.querySelector('h2')?.textContent).toBe('Subscriptions')
  expect(host.querySelectorAll('button')).toHaveLength(1)
})

it('retains the device scope and status next to header actions inside settings', async () => {
  root.render(<InSettingsPanelProvider><PageScopeProvider value={{ control: <button>This device</button>, status: <span>Online</span> }}>
    <PageHeader title="Subscriptions" aside={<button>Refresh</button>} />
  </PageScopeProvider></InSettingsPanelProvider>)
  await until('both header actions are available', () => host.querySelectorAll('button').length === 2)
  expect(host.querySelectorAll('h2')).toHaveLength(0)
  expect(host.querySelector('[data-slot="page-scope"]')?.textContent).toContain('This device')
  expect(host.querySelector('[data-slot="page-status"]')?.textContent).toBe('Online')
})
