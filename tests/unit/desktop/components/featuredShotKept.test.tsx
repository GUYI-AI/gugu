// @vitest-environment jsdom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * Owner 10-30 (a picture once shown is not a skeleton again): a featured picture kept from the last run draws its small
 * placeholder in the first frame (❌ a skeleton), and the same image switches to the picture once it is decoded.
 */
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, rpcOn: () => ({ extensions: {} }), onMachineEvent: () => () => undefined, events: { on: () => () => undefined } }))
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn() } }))
const decode = vi.hoisted(() => ({ release: () => {} }))
vi.mock('@renderer/features/extensions/panel/decoded-shots', () => {
  const done = new Set<string>()
  return {
    isDecoded: (src: string) => done.has(src),
    decodeShot: (src: string) => new Promise<void>((resolve) => { decode.release = () => { done.add(src); resolve() } }),
  }
})

const { featuredShot } = await import('@renderer/features/extensions/market-replicas')
const { AppFeaturedCard } = await import('@renderer/features/extensions/panel/app-featured')

beforeEach(() => { featuredShot.set(['local', 'pomo', '1.0.0'], { src: 'https://dl.example/market/media/pomo/1.0.0.png', placeholder: 'data:image/jpeg;base64,AAAA' }) })

it('draws the kept placeholder at once, then the picture in the same image once decoded', async () => {
  const harness = createReactHarness()
  await harness.render(createElement(AppFeaturedCard, {
    hostKey: 'local', id: 'pomo', version: '1.0.0', name: 'Pomo', subtitle: '', meta: '', lifecycle: { kind: 'get' },
    translate: ((key: string) => key) as never, onOpen: () => undefined, onAction: () => undefined,
  }))
  const art = () => harness.container.querySelector('.mk-hero-art')!
  expect(art().querySelector('[aria-busy="true"]')).toBeNull()
  expect(art().querySelectorAll('img')).toHaveLength(1)
  expect(art().querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
  await act(async () => { decode.release() })
  expect(art().querySelectorAll('img')).toHaveLength(1)
  expect(art().querySelector('img')!.getAttribute('src')).toBe('https://dl.example/market/media/pomo/1.0.0.png')
  harness.cleanup()
})
