import { mountComposerBandFrame } from '../../../../../../../tests/fixtures/composer-band-scroll/mount'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { PhoneComposerControl, PhoneComposerControlRow } from '@/mobile/composer/PhoneComposerControls'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'

let fixture: ReturnType<typeof mountComposerBandFrame> | undefined
let host: HTMLDivElement | undefined
afterEach(() => { fixture?.dispose(); host?.remove(); fixture = undefined; host = undefined })

// The phone task page's menu row (Work / Skills / Agents) is real; the transcript behind it is not needed for geometry.
const menuRow = () => <PhoneComposerControlRow>
  <PhoneComposerControl label="Work" menuExpanded={false} testId="fixture-work" onClick={() => {}} />
  <PhoneComposerControl label="Skills" menuExpanded={false} testId="fixture-skills" onClick={() => {}} />
</PhoneComposerControlRow>

it('fades messages into the input card, not above the transparent menu row, and keeps jump-to-latest above the row', async () => {
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;top:120px;left:0;width:390px'
  fixture = mountComposerBandFrame(host, { phone: true, composerProps: { renderPhoneHeader: menuRow } })
  await until('menu row, composer card and recovery button mounted', () => !!host!.querySelector('[data-testid="fixture-skills"]')
    && !!host!.querySelector('[data-slot="composer-bar"]') && !!host!.querySelector('button.aui-thread-scroll-to-bottom'))
  await untilStable('phone composer painted', () => [...host!.querySelectorAll('[data-phone-composer-controls], [data-slot="composer-bar"], [data-slot="aui-thread-scroll-to-bottom"]')].map(node => node.getBoundingClientRect().top))

  const layer = host.querySelector('[data-chat-composer-placement="bottom"]')!
  const bar = host.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
  const row = host.querySelector('[data-phone-composer-controls] > [data-composer-top-band]')!.getBoundingClientRect()
  expect(getComputedStyle(layer, '::before').content, 'no fade hangs off the layer top (the menu row top)').toBe('none')
  const fade = getComputedStyle(bar, '::after')
  expect(fade.content).not.toBe('none')
  expect(parseFloat(fade.bottom), 'the fade ends at the input card top edge').toBeCloseTo(bar.offsetHeight, 0)
  expect(row.bottom, 'the menu row sits above the card the fade belongs to').toBeLessThanOrEqual(bar.getBoundingClientRect().top + 1)

  const button = host.querySelector<HTMLButtonElement>('button.aui-thread-scroll-to-bottom')!.getBoundingClientRect()
  expect(button.bottom, 'jump-to-latest clears the menu row').toBeLessThanOrEqual(row.top + 1)
})
