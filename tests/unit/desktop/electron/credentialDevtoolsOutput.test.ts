import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { beforeAll, expect, it, vi } from 'vitest'
import { installDevtoolsLock } from '../../../../apps/desktop/electron/devtools-lock'

const native = vi.hoisted(() => ({ created: undefined as undefined | ((event: unknown, contents: WebContents) => void) }))
vi.mock('electron', () => ({ app: { isPackaged: true, on: (_event: string, callback: typeof native.created) => { native.created = callback } } }))
const breach = vi.fn<(url: string) => void>()
beforeAll(() => { installDevtoolsLock(breach) })

function fixture() {
  const url = `https://login.example.test/?token=${randomUUID()}`
  const page = Object.assign(new EventEmitter(), { session: {}, debugger: { isAttached: () => false },
    isDestroyed: (): boolean => false, getURL: vi.fn(() => url), closeDevTools: vi.fn() })
  const contents = page as unknown as WebContents
  native.created?.({}, contents)
  return { page, contents, url }
}

it('keeps the ordinary diagnostic and closes the native developer tools', () => {
  const { page, url } = fixture()
  page.emit('devtools-opened')
  expect(breach.mock.lastCall?.[0] === url).toBe(true)
  expect(page.closeDevTools.mock.calls.length).toBe(1)
})

it('still closes developer tools when the diagnostic consumer throws', () => {
  const { page } = fixture()
  breach.mockImplementationOnce(() => { throw new Error('diagnostic_failed') })
  expect(() => page.emit('devtools-opened')).toThrow('diagnostic_failed')
  expect(page.closeDevTools.mock.calls.length).toBe(1)
})
