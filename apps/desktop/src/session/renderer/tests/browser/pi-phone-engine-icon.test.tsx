import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { EngineIcon } from '@/components/AgentHarnessIdentity'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import '@/styles/tokens.css'

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); document.documentElement.removeAttribute('data-phone-shell') })
it.each(['light', 'dark'] as const)('%s phone: a decoded PNG has actual alpha and a readable 14px mark', async theme => {
  await page.viewport(390, 844)
  writeThemePreference(theme)
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await harness.render(<ThemeProvider><EngineIcon engine="pi" size={14} /></ThemeProvider>)
  const icon = harness.container.querySelector<HTMLElement>('[data-agent-harness="pi"]')!
  const image = icon.querySelector('img')!
  await image.decode()
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  expect(pixels[3]).toBe(0)
  const opaque = Array.from({ length: pixels.length / 4 }, (_, i) => i * 4).filter(i => pixels[i + 3] > 240)
  expect(opaque.length).toBeGreaterThan(100)
  expect(opaque.every(i => pixels[i] === (theme === 'dark' ? 255 : 0))).toBe(true)
  expect(icon.querySelector('.agent-harness-pi-mark')).toBeNull()
  expect(getComputedStyle(image).maskImage).toBe('none')
  expect(icon.getBoundingClientRect().width).toBeCloseTo(14)
  expect(icon.getBoundingClientRect().height).toBeCloseTo(14)
  expect(icon.getAttribute('aria-label')).toBe('Pi CLI')
})
