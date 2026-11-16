import { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import { PhoneWatchWindow } from '@/mobile/agent-watch/PhoneWatchWindow'
import { LiveWindowModel } from '@renderer/features/live-window/model'
import type { LiveWindowContext, LiveWindowSource } from '@renderer/features/live-window/types'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()) })

function topPoint(x: number, y: number) {
  for (let current: Window = window; current.frameElement; current = current.parent) {
    const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect(), scale = box.width / frame.offsetWidth
    x = box.left + (frame.clientLeft + x) * scale; y = box.top + (frame.clientTop + y) * scale
  }
  return { x, y }
}

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
      picture: <div data-testid={`picture-${item.id}`} data-live-window-picture={item.id} onPointerDown={clicked} style={{ width: '100%', height: '100%', background: '#b6c4d4' }} /> }))}
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

it('keeps both source tabs at the top of the small and enlarged picture', async () => {
  const { host, model } = await mount(true)
  expect(host.querySelectorAll('[data-phone-watch-switch] [role=tab]')).toHaveLength(2)
  expect(host.querySelector('[data-phone-watch-handle]')).toBeNull()
  await act(async () => model.dispatch({ type: 'enlarge' }))
  await page.getByRole('tab', { name: 'controlWatch.computer', exact: true }).click()
  expect(model.getSnapshot().source!.id).toBe('desktop')
  const enlarged = host.querySelector('[data-phone-watch-picture]')!.getBoundingClientRect()
  expect(enlarged.width / enlarged.height).toBeCloseTo(.8, 2)
  await act(async () => model.dispatch({ type: 'minimize' }))
  expect(host.querySelectorAll('[data-phone-watch-switch] [role=tab]')).toHaveLength(2)
  const frame = host.querySelector('[data-phone-watch-picture]')!.getBoundingClientRect()
  expect(frame.width / frame.height).toBeCloseTo(.8, 2)
})

it('keeps the last picture when the source finishes and hides the window with its conversation', async () => {
  const { host, model, context, source } = await mount()
  const picture = host.querySelector('[data-testid="picture-web"]')
  await act(async () => model.observe(context, [{ ...source, status: 'finished' }]))
  expect(model.getSnapshot().operating).toBe(false)
  expect(host.querySelector('[data-testid="picture-web"]')).toBe(picture)
  await act(async () => model.activate({ ...context, shown: false }))
  expect((host.querySelector('[data-phone-watch-window]') as HTMLElement).hidden).toBe(true)
  await act(async () => model.activate(context))
  expect((host.querySelector('[data-phone-watch-window]') as HTMLElement).hidden).toBe(false)
  expect(host.querySelector('[data-testid="picture-web"]')).toBe(picture)
})

it('requires two separate real touches when the first touch reveals a button under the finger', async () => {
  const { host, model } = await mount()
  const bounds = host.querySelector('[data-phone-watch-gesture]')!.getBoundingClientRect()
  const point = { ...topPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2), id: 1 }
  const session = cdp() as unknown as { send(method: string, params: object): Promise<unknown> }
  const tap = () => act(async () => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  })
  await tap()
  expect(model.getSnapshot().presentation!.mode).toBe('floating')
  expect(host.querySelector('[data-phone-watch-window]')!.getAttribute('data-revealed')).toBe('true')
  await tap()
  expect(model.getSnapshot().presentation!.mode).toBe('enlarged')
})

it('uses two real touch points to view a computer picture proportionally and restores that scale after minimizing', async () => {
  const { host, model } = await mount(true)
  await act(async () => { model.dispatch({ type: 'enlarge' }); model.dispatch({ type: 'select-source', sourceId: 'desktop' }) })
  const picture = host.querySelector<HTMLElement>('[data-testid="picture-desktop"]')!
  const bounds = host.querySelector('[data-phone-watch-picture]')!.getBoundingClientRect()
  const at = (x: number, id: number) => {
    return { ...topPoint(bounds.left + bounds.width / 2 + x, bounds.top + bounds.height / 2), id }
  }
  const session = cdp() as unknown as { send(method: string, params: object): Promise<unknown> }
  await act(async () => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(-20, 1), at(20, 2)] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(-40, 1), at(40, 2)] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  })
  expect(Number(picture.dataset.phoneWatchZoom)).toBeCloseTo(2, 1)
  const enlarged = picture.getBoundingClientRect()
  expect(enlarged.width / enlarged.height).toBeCloseTo(.8, 2)
  await act(async () => model.dispatch({ type: 'minimize' }))
  expect(picture.style.transform).toContain('scale(2')
  await act(async () => model.dispatch({ type: 'enlarge' }))
  expect(picture.style.transform).toContain('scale(2')
})

it('does not treat a zero-detail compatibility click as keyboard activation', async () => {
  const { host, model } = await mount()
  const bounds = host.querySelector('[data-phone-watch-gesture]')!.getBoundingClientRect()
  const session = cdp() as unknown as { send(method: string, params: object): Promise<unknown> }
  await act(async () => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...topPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2), id: 1 }] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  })
  const enlarge = host.querySelector<HTMLButtonElement>('[aria-label="controlWatch.enlarge"]')!
  await act(async () => enlarge.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })))
  expect(model.getSnapshot().presentation!.mode).toBe('floating')
  enlarge.focus()
  await userEvent.keyboard('{Enter}')
  expect(model.getSnapshot().presentation!.mode).toBe('enlarged')
})
