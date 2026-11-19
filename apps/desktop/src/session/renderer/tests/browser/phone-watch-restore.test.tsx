import { act, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import { Button } from '@/components/ui/Button'
import { LiveWindowHeaderIcon } from '@renderer/features/live-window/LiveWindowHeaderIcon'
import { PhoneWatchWindow } from '@/mobile/agent-watch/PhoneWatchWindow'
import { LiveWindowModel } from '@renderer/features/live-window/model'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function topPoint(x: number, y: number) {
  for (let current: Window = window; current.frameElement; current = current.parent) {
    const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect(), scale = box.width / frame.offsetWidth
    x = box.left + (frame.clientLeft + x) * scale; y = box.top + (frame.clientTop + y) * scale
  }
  return { x, y }
}

async function mount() {
  await page.viewport(390, 844)
  const host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'display:flex;flex-direction:column;position:relative;width:390px;height:700px'
  const root = createRoot(host)
  const model = new LiveWindowModel('phone')
  const context = { conversationId: 'private', deviceId: 'machine', sessionId: 'task', agentId: 'agent', privateAgentChat: true, shown: true }
  model.activate(context)
  model.observe(context, [{ id: 'web', kind: 'browser', deviceId: 'machine', sessionId: 'task', agentId: 'agent', title: 'Page',
    size: { width: 1280, height: 900 }, status: 'operating' }])
  function View() {
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
    const [expanded, setExpanded] = useState(false)
    return <><div style={{ position: 'relative', zIndex: 20, display: 'flex', height: 44, flex: 'none' }}><LiveWindowHeaderIcon snapshot={snapshot} dispatch={action => model.dispatch(action)} compact /></div><PhoneWatchWindow sources={snapshot.sources.map(source => ({ ...source, picture: <div /> }))}
      selectedId={snapshot.source!.id} presentation={snapshot.presentation!} visible={snapshot.visible}
      dispatch={action => model.dispatch(action)} onError={error => { throw error }}>
      <div data-chat-viewport style={{ flex: 1 }}>
        <Button data-message-control aria-label="Expand message" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? 'Full message' : 'Expand message'}
        </Button>
      </div>
      <div data-chat-composer-placement="bottom" style={{ height: 80, flex: 'none' }} />
    </PhoneWatchWindow></>
  }
  const trace: Array<{ type: string; target: string; mode: string | undefined }> = []
  const record = (event: Event) => {
    if (!(event.target instanceof Element) || !host.contains(event.target)) return
    trace.push({ type: event.type, target: event.target.closest('[data-live-window-toggle]') ? 'header'
      : event.target.closest('[data-message-control]') ? 'message' : 'other', mode: model.getSnapshot().presentation?.mode })
  }
  const events = ['pointerdown', 'pointerup', 'click']
  events.forEach(type => document.addEventListener(type, record, true))
  cleanups.push(async () => {
    events.forEach(type => document.removeEventListener(type, record, true))
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => root.render(<View />))
  await until('source picture positioned', () => host.querySelector<HTMLElement>('[data-phone-watch-window]')?.offsetWidth === 160)
  await act(async () => model.dispatch({ type: 'toggle-window' }))
  const handle = host.querySelector<HTMLElement>('[data-live-window-toggle]')!
  const box = handle.getBoundingClientRect()
  const message = host.querySelector<HTMLElement>('[data-message-control]')!
  const cover = (point: { x: number; y: number }) => Object.assign(message.style, {
    position: 'fixed', left: `${point.x - box.width / 2}px`, top: `${point.y - box.height / 2}px`, width: `${box.width}px`, height: `${box.height}px`,
  })
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  cover(point)
  expect(document.elementFromPoint(point.x, point.y)?.closest('[data-live-window-toggle]')).toBe(handle)
  const session = cdp() as unknown as { send(method: string, params: object): Promise<unknown> }
  const touch = (type: string, point?: { x: number; y: number }) => act(async () => {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...topPoint(point.x, point.y), id: 1 }] : [] })
  })
  return { host, model, handle, message, point, cover, touch, trace }
}

it('restores from the persistent header icon without expanding a message underneath', async () => {
  const { model, message, point, touch, trace } = await mount()
  await touch('touchStart', point)
  await touch('touchEnd')
  expect(model.getSnapshot().presentation!.mode).toBe('floating')
  expect(trace, JSON.stringify(trace)).toEqual([
    { type: 'pointerdown', target: 'header', mode: 'closed' },
    { type: 'pointerup', target: 'header', mode: 'closed' },
    { type: 'click', target: 'header', mode: 'closed' },
  ])
  expect(message.getAttribute('aria-expanded')).toBe('false')
})

it('does not activate the message after a touch moves away from the header icon', async () => {
  const { model, message, point, cover, touch, trace } = await mount()
  const end = { x: 70, y: point.y + 40 }
  cover(end)
  await touch('touchStart', point)
  await touch('touchMove', { x: (point.x + end.x) / 2, y: (point.y + end.y) / 2 })
  await touch('touchMove', end)
  await touch('touchEnd')
  expect(model.getSnapshot().presentation!.mode).toBe('closed')
  expect(trace.filter(event => event.type === 'click' && event.target === 'message')).toEqual([])
  expect(message.getAttribute('aria-expanded')).toBe('false')
})

it.each(['{Enter}', ' ', 'click'])('preserves non-pointer activation with %j after a canceled touch', async key => {
  const { model, handle, message, point, touch } = await mount()
  await touch('touchStart', point)
  await touch('touchCancel')
  expect(model.getSnapshot().presentation!.mode).toBe('closed')
  handle.focus()
  if (key === 'click') await act(async () => handle.click())
  else await userEvent.keyboard(key)
  expect(model.getSnapshot().presentation!.mode).toBe('floating')
  expect(message.getAttribute('aria-expanded')).toBe('false')
})
