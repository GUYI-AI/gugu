/**
 * Button text sits on its body line height, not line-height 1. A label that truncates inside a Button
 * (overflow hidden + ellipsis) clipped its descenders (g, p, y) when the line box was only as tall as the font size —
 * the phone's Topics / Agents controls showed it. Real Chromium, real tokens, every variant × size.
 */
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/Button'
import '@/styles/tokens.css'
import '@renderer/index.css'

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'option']
const SIZES: ButtonSize[] = ['sm', 'md', 'lg', 'xl', 'icon', 'option']
const CONTROL_H: Record<ButtonSize, number> = { sm: 28, md: 32, lg: 36, xl: 40, icon: 32, option: 44 }

let root: Root | null = null
afterEach(() => { root?.unmount(); root = null; document.body.replaceChildren() })

it.each([[1024, 'desktop'], [390, 'phone']] as const)('%i wide (%s): a truncating label keeps its glyphs and no button grows', async (width, _surface) => {
  await page.viewport(width, 800)
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  flushSync(() => root!.render(<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
    {VARIANTS.flatMap((variant) => SIZES.map((size) => <Button key={`${variant}-${size}`} variant={variant} size={size} data-case={`${variant}/${size}`}>
      <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Agents typing gyp a long label</span>
    </Button>))}
  </div>))
  await document.fonts.ready
  const touch = width < 720
  for (const button of host.querySelectorAll<HTMLElement>('[data-case]')) {
    const label = button.querySelector('span')!
    const size = button.dataset.case!.split('/')[1] as ButtonSize
    expect(label.scrollHeight, `${button.dataset.case}: the label's glyphs overflow its clipped line box`).toBeLessThanOrEqual(label.clientHeight)
    const expected = touch ? Math.max(CONTROL_H[size], 44) : CONTROL_H[size]
    expect(button.getBoundingClientRect().height, `${button.dataset.case}: height`).toBe(expected)
  }
})
