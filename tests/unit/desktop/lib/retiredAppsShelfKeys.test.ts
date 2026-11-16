// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

/** The App page's own kept shelf and picture (before the read model) leave localStorage: they took the snapshot's quota. */
it('drops the retired shelf and picture keys when the market models load, and nothing else', async () => {
  localStorage.setItem('gugu.appsShelf.v1:local', JSON.stringify({ items: ['a whole catalog'] }))
  localStorage.setItem('gugu.appsShelf.v1:remote:d1', '{}')
  localStorage.setItem('gugu.appsShot.v1', '{}')
  localStorage.setItem('gugu.other', 'kept')
  vi.resetModules()
  await import('../../../../apps/desktop/src/session/renderer/features/extensions/market-replicas')
  expect(localStorage.getItem('gugu.appsShelf.v1:local')).toBeNull()
  expect(localStorage.getItem('gugu.appsShelf.v1:remote:d1')).toBeNull()
  expect(localStorage.getItem('gugu.appsShot.v1')).toBeNull()
  expect(localStorage.getItem('gugu.other')).toBe('kept')
})
