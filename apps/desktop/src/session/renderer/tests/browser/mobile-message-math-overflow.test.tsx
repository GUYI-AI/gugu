import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({
  ...(await original<object>()),
  getSupabaseUrl: () => 'http://supabase.test.local',
  getSupabaseAnonKey: () => 'test-anon-key',
}))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

const { MessageBubble } = await import('@/components/chat/MessageBubble')

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

const MATH_MESSAGE = [
  '吉米 4178：$I = \\iint_{\\mathbb{R}^2} e^{ax^2+2bxy+cy^2+2dx+2ey+f}\\,dxdy$，$x$ 是实数。',
  '',
  '$$ax^2+2(by+d)x = a\\left(x+\\frac{by+d}{a}\\right)^2 - \\frac{(by+d)^2}{a}$$',
  '',
  '$$\\frac{\\Delta}{a}$$',
].join('\n')

it('keeps every formula of a phone message reachable inside its bubble', async () => {
  const viewportWidth = 390
  await page.viewport(viewportWidth, 844)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = `position:fixed;inset:0 auto auto 0;width:${viewportWidth}px`
  await renderWithAppProviders(harness, <MessageBubble
    msg={message({ id: 'math', is_mine: false, content: MATH_MESSAGE })}
    isGroup
    compactMobile
    onReaction={vi.fn()}
    onQuote={vi.fn()}
    onForward={vi.fn()}
    onDelete={vi.fn()}
  />)
  await until('formulas typeset', () => harness.container.querySelectorAll('.gg-md .katex').length === 4)
  await document.fonts.ready

  const body = harness.container.querySelector<HTMLElement>('.gg-md')!.getBoundingClientRect()
  const [wide, fitting] = [...harness.container.querySelectorAll<HTMLElement>('.katex-display')]
  for (const display of [wide, fitting]) {
    const box = display.getBoundingClientRect()
    const formula = display.querySelector<HTMLElement>('.katex')!.getBoundingClientRect()
    expect(box.left - formula.left, 'a display formula starts left of its scroll box, where no scroll reaches').toBeLessThanOrEqual(0.5)
  }
  expect(wide.scrollWidth, 'the wide display formula does not scroll').toBeGreaterThan(wide.clientWidth)
  const fittingBox = fitting.getBoundingClientRect()
  const fittingFormula = fitting.querySelector<HTMLElement>('.katex')!.getBoundingClientRect()
  expect(Math.abs((fittingFormula.left - fittingBox.left) - (fittingBox.right - fittingFormula.right)), 'a display formula that fits is off centre').toBeLessThanOrEqual(1)

  const [integral, short] = [...harness.container.querySelectorAll<HTMLElement>('p .katex')]
  expect(integral.getBoundingClientRect().right, 'the wide inline formula ran out of the message body').toBeLessThanOrEqual(body.right + 0.5)
  expect(integral.scrollWidth, 'the wide inline formula does not scroll').toBeGreaterThan(integral.clientWidth)
  expect(short.scrollWidth, 'an inline formula that fits became a scroll box').toBe(short.clientWidth)

  // An inline formula sits on the text's baseline: a probe on the paragraph's line and one on the formula's own
  // line inside its scroll box end at the same y.
  const probe = () => Object.assign(document.createElement('span'), { style: 'display:inline-block;width:0;height:0' })
  const outer = probe(), inner = probe()
  short.before(outer)
  short.querySelector('.katex-html')!.prepend(inner)
  expect(Math.abs(inner.getBoundingClientRect().bottom - outer.getBoundingClientRect().bottom), 'the inline formula left the text baseline').toBeLessThanOrEqual(0.5)

  expect(harness.container.scrollWidth, 'the message made the phone page scroll sideways').toBeLessThanOrEqual(viewportWidth)
})
