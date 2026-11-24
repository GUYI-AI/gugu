import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { NoticeHost } from '@/components/NoticeHost'
import { dismissNotice, notify } from '@/lib/notices'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

let harness: ReturnType<typeof createReactHarness>
afterEach(() => { dismissNotice('clearance'); harness?.cleanup() })
const card = () => document.querySelector<HTMLElement>('[data-sonner-toast]')!
const composer = () => document.querySelector<HTMLElement>('[data-testid="visible-composer"]')!
const gap = () => composer().getBoundingClientRect().top - card().getBoundingClientRect().bottom

// Exercise real Sonner positioning and hit testing, rather than asserting a calculated offset.
function Layout({ height = 120, split = false, filePane = false, hidden = false }: { height?: number; split?: boolean; filePane?: boolean; hidden?: boolean }) {
  return <><NoticeHost />
    <div style={{ position: 'fixed', left: 200, right: filePane ? 240 : 20, bottom: 20, display: hidden ? 'none' : 'flex', gap: 12 }}>
      {split && <div data-slot="composer" style={{ width: '40%', height: height + 50, background: 'white' }}><textarea aria-label="Topic message" /></div>}
      <div data-slot="composer" data-testid="visible-composer" style={{ flex: 1, height, background: 'white', position: 'relative' }}>
        <textarea aria-label="Message" style={{ width: '100%', height: '100%' }} /><button data-testid="send" style={{ position: 'absolute', right: 4, bottom: 4 }}>Send</button>
      </div>
    </div>
    <div style={{ position: 'fixed', inset: 0, contentVisibility: 'hidden', pointerEvents: 'none' }}>
      <div data-slot="composer" style={{ position: 'absolute', top: 10, width: 400, height: 500 }} />
    </div>
  </>
}

// A retained surface hides inline (RETAINED_SURFACE_HIDDEN_STYLE: content-visibility, transform), keeping its box: no
// ResizeObserver entry. The style MutationObserver is what moves the notice.
it('follows a retained surface shown or hidden by its inline style, box unchanged', async () => {
  await page.viewport(1200, 800)
  harness = createReactHarness()
  await harness.render(<><NoticeHost />
    <div data-testid="surface" style={{ position: 'fixed', inset: 0, ...RETAINED_SURFACE_HIDDEN_STYLE }}>
      <div data-slot="composer" style={{ position: 'absolute', left: 200, right: 20, bottom: 200, height: 120 }} />
    </div>
  </>)
  await act(async () => { notify({ key: 'clearance', title: 'Please retry this operation.', tier: 'error', duration: 600_000 }) })
  await until('notice subscribes', () => !!card())
  const surface = document.querySelector<HTMLElement>('[data-testid="surface"]')!
  const inner = surface.querySelector<HTMLElement>('[data-slot="composer"]')!
  const hidden = surface.getAttribute('style')
  await until('a hidden surface keeps the ordinary inset', () => window.innerHeight - card().getBoundingClientRect().bottom < 50)
  surface.setAttribute('style', 'position: fixed; inset: 0px;')
  await until('shown: the notice clears its composer', () => inner.getBoundingClientRect().top - card().getBoundingClientRect().bottom >= 7)
  surface.setAttribute('style', hidden!)
  await until('hidden again: back to the ordinary inset', () => window.innerHeight - card().getBoundingClientRect().bottom < 50)
})

// A fold writes inline styles on ancestors of every composer each frame (an opacity, a transform when it slides the
// content). Neither shows nor hides a composer: the style record must not read the composers
// again before the next layout.
it('does not re-read the composers for inline writes that neither show nor hide them', async () => {
  await page.viewport(1200, 800)
  harness = createReactHarness()
  await harness.render(<Layout />)
  await act(async () => { notify({ key: 'clearance', title: 'Please retry this operation.', tier: 'error', duration: 600_000 }) })
  await until('notice is 8px above the composer', () => !!card() && Math.abs(gap() - 8) < 1)
  const ancestor = composer().parentElement!
  const query = vi.spyOn(document, 'querySelectorAll')
  for (let frame = 0; frame < 10; frame++) {
    ancestor.style.opacity = String(1 - frame / 20)
    ancestor.style.transform = `translateX(${frame}px)`
    await new Promise(requestAnimationFrame)
  }
  await new Promise(requestAnimationFrame)
  const reads = query.mock.calls.filter(([selector]) => selector === '[data-slot="composer"]').length
  query.mockRestore()
  expect(reads, 'composer reads caused by style writes that change no visibility').toBe(0)
})

// A pane moving sideways (a fold, a resize) leaves the composer's height alone, so no read follows it. The notice shown
// afterwards is centred on where the composer is now, not where it was at the last read.
it('centres a notice on the composer it sits above after the composer moved sideways', async () => {
  await page.viewport(1200, 800)
  harness = createReactHarness()
  await harness.render(<Layout />)
  await act(async () => { notify({ key: 'clearance', title: 'Saved.', duration: 600_000 }) })
  await until('notice is 8px above the composer', () => !!card() && Math.abs(gap() - 8) < 1)
  await act(async () => { dismissNotice('clearance') })
  await until('notice gone', () => !card())
  composer().parentElement!.style.left = '20px'
  composer().parentElement!.style.right = '600px'
  await new Promise(requestAnimationFrame)
  await act(async () => { notify({ key: 'clearance', title: 'Applied.', duration: 600_000 }) })
  const centre = (box: DOMRect) => box.left + box.width / 2
  await until('the notice is centred on the moved composer', () => !!card() && Math.abs(centre(card().getBoundingClientRect()) - centre(composer().getBoundingClientRect())) < 2)
})
