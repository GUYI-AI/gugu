/**
 * Pressing Edit in the image viewer: the picture stays on screen until the editor can show it, so no frame between them
 * is the editor's light loading page (or the viewer with its picture hidden). A slow original still gets the loading page,
 * once the wait is long enough to need saying. Real Chromium, real PhotoSwipe, the product's styles; every frame sampled.
 */
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../../../../../tests/support/testHarness'
import { ImagePreviewProvider } from '@/components/ImagePreviewProvider'
import { openImageViewer } from '@/lib/imageViewer'
import 'photoswipe/style.css'
import '@/styles/tokens.css'
import '@/components/imagePreview.css'

vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({}) } })
vi.mock('@/components/imageAnnotate/useAnnotateActions', () => ({ useAnnotateActions: () => ({ busy: false, error: null }) }))
vi.mock('@/components/imageAnnotate/AnnotateDoneMenu', () => ({ AnnotateDoneMenu: () => null }))

let harness: ReturnType<typeof createReactHarness> | null = null
afterEach(() => { harness?.cleanup(); harness = null })

function picture(): string {
  const canvas = Object.assign(document.createElement('canvas'), { width: 800, height: 600 })
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#2a6fdb'; ctx.fillRect(0, 0, 800, 600)
  return canvas.toDataURL('image/png')
}

/** What is drawn on each frame, topmost first: the editor, its loading page, the viewer's picture, or nothing. */
function sampleFrames(ms: number): Promise<{ t: number; shows: string }[]> {
  const frames: { t: number; shows: string }[] = []
  const start = performance.now()
  return new Promise((resolve) => {
    const tick = () => {
      const drawn = (selector: string) => [...document.querySelectorAll(selector)].some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible')
      const shows = drawn('.ia-editor:not(.ia-loading)') ? 'editor' : drawn('.ia-loading') ? 'loading' : drawn('.pswp__img:not(.pswp__img--placeholder)') ? 'viewer' : 'nothing'
      if (frames.at(-1)?.shows !== shows) frames.push({ t: Math.round(performance.now() - start), shows })
      if (performance.now() - start < ms) requestAnimationFrame(tick)
      else resolve(frames)
    }
    requestAnimationFrame(tick)
  })
}

async function openAndEdit(originalAfterMs: number) {
  await page.viewport(1024, 720)
  await import('@/components/imageAnnotate/AnnotateEditor')
  const url = picture()
  harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(ImagePreviewProvider, null, createNode('div')))
  const full = () => new Promise<string>((resolve) => setTimeout(resolve, originalAfterMs, url))
  await act(async () => openImageViewer([{ url, alt: 'photo.png', size: { width: 800, height: 600 }, full }], 0))
  const shown = () => document.querySelector<HTMLImageElement>('.pswp__img:not(.pswp__img--placeholder)')
  await waitForCondition(() => Boolean(shown()?.complete && shown()?.naturalWidth && !document.querySelector('.pswp__img--placeholder')), 'viewer did not show the picture')
  const frames = sampleFrames(originalAfterMs + 700)
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await clickElement(document.querySelector<HTMLElement>('[data-testid="image-preview-edit"]')!)
  return frames
}

it('goes from the viewer\'s picture straight to the editor\'s when the original is quick', async () => {
  const frames = await openAndEdit(150)
  expect(frames.map((frame) => frame.shows)).toEqual(['viewer', 'editor'])
})

it('says it is loading only once a slow original has kept the picture waiting', async () => {
  const frames = await openAndEdit(1200)
  expect(frames.map((frame) => frame.shows)).toEqual(['viewer', 'loading', 'editor'])
  expect(frames[1]!.t).toBeGreaterThanOrEqual(280)
})
