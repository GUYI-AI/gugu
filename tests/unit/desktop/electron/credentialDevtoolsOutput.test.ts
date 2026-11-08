import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { beforeAll, expect, it, vi } from 'vitest'
import { installDevtoolsLock } from '../../../../apps/desktop/electron/devtools-lock'
import { markCredentialHandoffCandidate, registerPrivateCredentialSurface, restrictCredentialPartition } from '../../../../apps/desktop/electron/session/main/core/browser/credential-isolation-registry'

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

it('never reads the URL of a private credential surface', () => {
  const { page, contents } = fixture()
  const release = registerPrivateCredentialSurface({ loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(),
    browserId: randomUUID(), partition: randomUUID(), contents })
  try {
    page.emit('devtools-opened')
    expect(page.getURL.mock.calls.length).toBe(0)
    expect(breach.mock.lastCall?.[0]).toBe('<credential-isolated>')
    expect(page.closeDevTools.mock.calls.length).toBe(1)
  } finally { page.isDestroyed = () => true; release() }
})

it('redacts an unpublished candidate and an isolated partition', () => {
  const candidate = fixture(), isolated = fixture()
  markCredentialHandoffCandidate(candidate.contents)
  const release = restrictCredentialPartition(randomUUID(), isolated.page.session, { allowsPublication: () => false })
  try {
    for (const { page } of [candidate, isolated]) {
      page.emit('devtools-opened')
      expect(page.getURL.mock.calls.length).toBe(0)
      expect(breach.mock.lastCall?.[0]).toBe('<credential-isolated>')
      expect(page.closeDevTools.mock.calls.length).toBe(1)
    }
  } finally { release() }
})

it('still closes developer tools when the diagnostic consumer throws', () => {
  const { page } = fixture()
  breach.mockImplementationOnce(() => { throw new Error('diagnostic_failed') })
  expect(() => page.emit('devtools-opened')).toThrow('diagnostic_failed')
  expect(page.closeDevTools.mock.calls.length).toBe(1)
})
