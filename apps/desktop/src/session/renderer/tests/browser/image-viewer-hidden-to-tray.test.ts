/**
 * Closing the main window puts gugu in the tray. The image viewer fills the window, so one left open would be all the
 * window shows when it comes back from there: it closes with the window (@@@viewer-to-tray). An edit in progress stays.
 * Real Chromium, real PhotoSwipe.
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
let toTray = new Set<() => void>()
afterEach(() => {
  harness?.cleanup(); harness = null
  toTray = new Set()
  delete window.desktopWindow
})

function picture(): string {
  const canvas = Object.assign(document.createElement('canvas'), { width: 800, height: 600 })
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#2a6fdb'; ctx.fillRect(0, 0, 800, 600)
  return canvas.toDataURL('image/png')
}

/** The main process saying the window was closed into the tray (electron/main.ts close handler). */
function hideToTray() {
  act(() => toTray.forEach((callback) => callback()))
}

async function openViewer() {
  await page.viewport(1024, 720)
  window.desktopWindow = {
    onHiddenToTray: (callback: () => void) => { toTray.add(callback); return () => { toTray.delete(callback) } },
  } as unknown as Window['desktopWindow']
  harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(ImagePreviewProvider, null, createNode('div')))
  await act(async () => openImageViewer([{ url: picture(), alt: 'photo.png', size: { width: 800, height: 600 } }], 0))
  await waitForCondition(() => Boolean(document.querySelector('[data-testid="image-preview-close"]')), 'viewer did not open')
  // Past the opening animation: PhotoSwipe takes no close before it ends.
  await new Promise((resolve) => setTimeout(resolve, 700))
}

it('closes the image viewer when the window goes to the tray', async () => {
  await openViewer()
  hideToTray()
  await waitForCondition(() => !document.querySelector('.pswp'), 'the viewer is still open over the window that went to the tray')
  expect(toTray.size).toBe(0)
})

it('keeps an edit in progress when the window goes to the tray', async () => {
  await import('@/components/imageAnnotate/AnnotateEditor')
  await openViewer()
  await clickElement(document.querySelector<HTMLElement>('[data-testid="image-preview-edit"]')!)
  await waitForCondition(() => Boolean(document.querySelector('.ia-editor')), 'editor did not open')
  hideToTray()
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(document.querySelector('.ia-editor')).not.toBeNull()
})
