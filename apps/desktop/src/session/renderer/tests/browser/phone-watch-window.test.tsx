import { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { PhoneWatchWindow } from '@/mobile/agent-watch/PhoneWatchWindow'
import { LiveWindowModel } from '@renderer/features/live-window/model'
import type { LiveWindowContext, LiveWindowSource } from '@renderer/features/live-window/types'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()) })

async function mount(both = false) {
  await page.viewport(390, 844)
  const host = document.createElement('div')
  host.style.cssText = 'width:390px;height:700px;display:flex;flex-direction:column'
  document.body.append(host)
  const root = createRoot(host)
  const context: LiveWindowContext = { conversationId: 'private', deviceId: 'machine', sessionId: 'task', agentId: 'agent', privateAgentChat: true, shown: true }
  const source: LiveWindowSource = { id: 'web', kind: 'browser', deviceId: 'machine', sessionId: 'task', agentId: 'agent', title: 'Page', size: { width: 1280, height: 720 }, status: 'operating' }
  const model = new LiveWindowModel('phone')
  model.activate(context)
  model.observe(context, [source, ...(both ? [{ ...source, id: 'desktop', kind: 'computer' as const, size: { width: 800, height: 1000 } }] : [])])
  const clicked = vi.fn()
  const errors = vi.fn()
  function View() {
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
    return <PhoneWatchWindow sources={snapshot.sources.map(item => ({ ...item,
      picture: <div data-testid={`picture-${item.id}`} onPointerDown={clicked} style={{ width: '100%', height: '100%', background: '#b6c4d4' }} /> }))}
      selectedId={snapshot.source?.id ?? null} presentation={snapshot.presentation!} visible={snapshot.visible}
      dispatch={action => model.dispatch(action)} onError={errors}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div data-chat-viewport style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><p>Latest reply stays below the picture</p></div>
        <div data-chat-composer-placement="bottom" style={{ height: 80, flex: 'none' }}><textarea aria-label="Reply" /></div>
      </div>
    </PhoneWatchWindow>
  }
  await act(async () => root.render(<View />))
  cleanups.push(() => { act(() => root.unmount()); host.remove() })
  await until('real source dimensions positioned', () => (host.querySelector('[data-phone-watch-window]') as HTMLElement).offsetWidth === 160)
  return { host, model, context, source, clicked, errors }
}

it('reveals the central action on a first tap and enlarges on its button without remounting the picture', async () => {
  const { host, model, clicked } = await mount()
  const picture = host.querySelector('[data-testid="picture-web"]')
  expect(getComputedStyle(host.querySelector('[data-phone-watch-small-actions]')!).visibility).toBe('hidden')
  await page.getByRole('region', { name: 'controlWatch.picture' }).click()
  expect(model.getSnapshot().presentation!.mode).toBe('floating')
  expect(clicked).not.toHaveBeenCalled()
  await page.getByRole('button', { name: 'controlWatch.enlarge', exact: true }).click()
  expect(model.getSnapshot().presentation!.mode).toBe('enlarged')
  expect(host.querySelector('[data-testid="picture-web"]')).toBe(picture)
  const frame = host.querySelector('[data-phone-watch-window]')!.getBoundingClientRect()
  const conversation = host.querySelector('[data-chat-viewport]')!.getBoundingClientRect()
  expect(conversation.top).toBeGreaterThanOrEqual(frame.bottom)
  expect(conversation.height).toBeGreaterThan(0)
  expect(host.querySelectorAll('[data-phone-watch-toolbar] button')).toHaveLength(2)
  await page.getByRole('textbox', { name: 'Reply', exact: true }).click()
  expect(model.getSnapshot().presentation!.mode).toBe('floating')
  expect(host.querySelector('[data-testid="picture-web"]')).toBe(picture)
})

it('restores a docked window on the same side and keeps source labels out of the small picture', async () => {
  const { host, model } = await mount(true)
  expect(host.querySelector('[data-phone-watch-switch]')).toBeNull()
  await act(async () => model.dispatch({ type: 'dock', edge: 'left', ratio: .2 }))
  expect(host.querySelector('[data-phone-watch-grip]')).not.toBeNull()
  await page.getByRole('button', { name: 'controlWatch.restore', exact: true }).click()
  expect(model.getSnapshot().presentation!.small.corner).toBe('top-left')
  expect(model.getSnapshot().presentation!.mode).toBe('floating')
  await act(async () => model.dispatch({ type: 'enlarge' }))
  await page.getByRole('tab', { name: 'controlWatch.computer', exact: true }).click()
  expect(model.getSnapshot().source!.id).toBe('desktop')
  await act(async () => model.dispatch({ type: 'minimize' }))
  expect(host.querySelector('[data-phone-watch-switch]')).toBeNull()
  const frame = host.querySelector('[data-phone-watch-window]')!.getBoundingClientRect()
  expect(frame.width / frame.height).toBeCloseTo(.8, 2)
})

it('keeps the last picture when the source finishes and hides the window with its conversation', async () => {
  const { host, model, context } = await mount()
  const picture = host.querySelector('[data-testid="picture-web"]')
  await act(async () => model.observe(context, []))
  expect(model.getSnapshot().operating).toBe(false)
  expect(host.querySelector('[data-testid="picture-web"]')).toBe(picture)
  await act(async () => model.activate({ ...context, shown: false }))
  expect((host.querySelector('[data-phone-watch-window]') as HTMLElement).hidden).toBe(true)
  await act(async () => model.activate(context))
  expect((host.querySelector('[data-phone-watch-window]') as HTMLElement).hidden).toBe(false)
  expect(host.querySelector('[data-testid="picture-web"]')).toBe(picture)
})
