// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, it, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const file = { id: 'readme', name: 'README.md', displayName: 'README.md', type: 'text', contentType: 'text/markdown', parentId: null, path: 'README.md', chat: 'chat', systemRole: null, version: 1, createdBy: null, createdAt: '2026-11-03T08:00:00Z', updatedAt: '2026-11-03T08:00:00Z', sourceMessageIds: [], canDelete: true, size: 3 }
const photo = (id: string) => ({ ...file, id, name: `${id}.png`, displayName: `${id}.png`, type: 'binary', contentType: 'image/png', path: `${id}.png` })
const gugu = {
  linkTo: async () => 'gugu-file://readme',
  getContext: async () => ({ chat: { id: 'chat', kind: 'group', name: 'Files', groupId: null, members: [] }, locale: 'en-US', capabilities: ['files:read', 'files:write'] }),
  setTabTitle: vi.fn(async () => {}),
  onContextChanged: () => () => {},
  onLink: () => () => {},
  showContextMenu: vi.fn(async () => null),
  files: {
    viewPreferences: async () => ({ showAppData: false }),
    list: async () => [{ ...file }, { ...photo('a') }, { ...photo('b') }],
    onChanged: () => () => {},
    openWith: vi.fn(async (_file: unknown, _options: unknown) => {}),
  },
}

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu, CSS: { escape: (value: string) => value } })
  Object.assign(window, { gugu })
  // @ts-expect-error The built-in App runs directly as JavaScript.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the real folder lists its file or reports an error', () => document.querySelector('.file-open') !== null || !!document.getElementById('doc-message')?.textContent)
  expect(document.getElementById('doc-message')?.textContent).toBe('')
})

const openOf = (id: string) => document.querySelector(`li[data-id="${id}"] .file-open`) as HTMLButtonElement

it('single and double clicks navigate without creating a pinned or preview state', async () => {
  const button = openOf('readme')
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
  expect(gugu.files.openWith.mock.calls).toEqual([[file, expect.objectContaining({ intent: 'navigate', viewState: expect.objectContaining({ root: 'chat' }) })], [file, expect.objectContaining({ intent: 'navigate' })]])
})
it('explicit gestures override ordinary navigation through the same openWith call', () => {
  gugu.files.openWith.mockClear()
  const button = openOf('readme')
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
  button.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
  expect(gugu.files.openWith.mock.calls.map((args: unknown[]) => (args[1] as { intent: string }).intent)).toEqual(['newTab', 'newTab', 'beside'])
})
it('an image tells the host the images drawn with it, in their order, and where its picture is (API 57)', () => {
  gugu.files.openWith.mockClear()
  const mark = document.querySelector('li[data-id="b"] .file-mark') as HTMLElement
  mark.getBoundingClientRect = () => ({ x: 12, y: 34, width: 40, height: 40 }) as DOMRect
  openOf('b').click()
  const order = [...document.querySelectorAll<HTMLElement>('#file-list li[data-id]')].map((li) => li.dataset.id).filter((id) => id !== 'readme')
  const [entry, options] = gugu.files.openWith.mock.calls[0] as [{ id: string }, { among?: { id: string }[]; origin?: unknown }]
  expect(entry.id).toBe('b')
  expect(options.among?.map((image) => image.id)).toEqual(order)
  expect(options.origin).toEqual({ x: 12, y: 34, width: 40, height: 40 })
  // Not an image, or 「用别的 App 打开」: nothing of the viewer's.
  gugu.files.openWith.mockClear()
  openOf('readme').click()
  expect(gugu.files.openWith.mock.calls[0]![1]).not.toHaveProperty('among')
  expect(gugu.files.openWith.mock.calls[0]![1]).not.toHaveProperty('origin')
})
