import { mountComposerBandFrame } from '../../../../../../../tests/fixtures/composer-band-scroll/mount'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import { ScheduledBand, type FrameOptions } from '../../../../../../../tests/fixtures/composer-band-scroll/frame'

let fixture: ReturnType<typeof mountComposerBandFrame> | undefined
let host: HTMLDivElement | undefined
afterEach(() => { fixture?.dispose(); host?.remove(); fixture = undefined; host = undefined })

async function mount(options: FrameOptions) {
  await page.viewport(900, 720)
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;top:80px;left:80px;width:640px'
  fixture = mountComposerBandFrame(host, options)
  await until('actual recovery button and composer mounted', () => !!host?.querySelector('[data-slot="aui-thread-scroll-to-bottom"] button') && !!host?.querySelector('[data-slot="composer-bar"]'))
  await untilStable('composer geometry settled', () => [...host!.querySelectorAll('[data-slot="composer"], [data-slot="aui-thread-scroll-to-bottom"]')].map(element => element.getBoundingClientRect().top))
  return host.querySelector<HTMLButtonElement>('[data-slot="aui-thread-scroll-to-bottom"] button')!
}

it.each(['none', 'schedule', 'queued'] as const)('keeps the whole recovery button reachable above %s', async kind => {
  const onScrollToBottom = vi.fn()
  const button = await mount({ scheduled: kind === 'schedule', band: kind === 'schedule' ? <ScheduledBand /> : undefined,
    composerProps: kind === 'queued' ? { isWorking: true, queuedPrompts: [{ id: 'fixture-queued', text: 'Controlled queued input', origin: 'typed' }], onEditQueuedPrompt: () => {}, onDeleteQueuedPrompt: () => {}, onReorderQueuedPrompts: () => {}, onSendQueuedPromptNow: () => {} } : undefined,
    onScrollToBottom })
  const rect = button.getBoundingClientRect()
  const composer = host!.querySelector('[data-slot="composer"]')!.getBoundingClientRect()
  const band = host!.querySelector(kind === 'schedule' ? '[data-composer-band]' : '[data-slot="composer-queued-prompts"]')
  if (band) expect(rect.bottom, 'the button must not cover the top band or its text').toBeLessThanOrEqual(band.getBoundingClientRect().top + 1)
  else expect(rect.bottom - composer.top, 'without a band keep the existing half overlap').toBeCloseTo(rect.height / 2, 0)
  for (const fraction of [.15, .5, .85]) {
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * fraction)
    expect(hit && button.contains(hit), `the whole button must receive pointer input at ${fraction}`).toBe(true)
  }
  await page.getByRole('button', { name: 'Return to bottom', exact: true }).click()
  expect(onScrollToBottom).toHaveBeenCalledOnce()
})


it.each([
  { width: 640, theme: 'dark' as const },
  { width: 360, theme: 'light' as const },
  { width: 360, theme: 'dark' as const },
])('clears the stacked bands at $width px in $theme', async ({ width, theme }) => {
  const onScrollToBottom = vi.fn()
  await mount({ theme, scheduled: true, phone: width < 400, band: <ScheduledBand />,
    composerProps: { isWorking: true, queuedPrompts: [{ id: 'controlled', text: 'Controlled queued input', origin: 'typed' }],
      onEditQueuedPrompt: () => {}, onDeleteQueuedPrompt: () => {}, onReorderQueuedPrompts: () => {}, onSendQueuedPromptNow: () => {} }, onScrollToBottom })
  host!.style.width = `${width}px`
  await untilStable('stacked bands resized', () => host!.querySelector('[data-composer-band]')!.getBoundingClientRect().top)
  const button = host!.querySelector<HTMLButtonElement>('button.aui-thread-scroll-to-bottom')!
  const rect = button.getBoundingClientRect()
  const band = host!.querySelector('[data-composer-band]')!.getBoundingClientRect()
  expect(rect.bottom).toBeLessThanOrEqual(band.top + 1)
  expect(button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 1))).toBe(true)
  await page.getByRole('button', { name: 'Return to bottom', exact: true }).click()
  expect(onScrollToBottom).toHaveBeenCalledOnce()
})

it('tracks the first band appearing and disappearing across the two portals', async () => {
  await mount({})
  const read = () => host!.querySelector('button.aui-thread-scroll-to-bottom')!.getBoundingClientRect()
  const initial = read()
  fixture!.render({ scheduled: true, band: <ScheduledBand /> })
  await until('scheduled tray appears', () => !!host!.querySelector('[data-composer-band]'))
  await untilStable('scheduled tray painted', () => read().top)
  expect(read().bottom).toBeLessThanOrEqual(host!.querySelector('[data-composer-band]')!.getBoundingClientRect().top + 1)
  fixture!.render({})
  await until('scheduled tray disappears', () => !host!.querySelector('[data-composer-band]'))
  await untilStable('plain composer painted', () => read().top)
  expect(read().bottom).toBeCloseTo(initial.bottom, 0)
})

it('keeps the at-bottom control mounted, disabled and invisible', async () => {
  const button = await mount({ scheduled: true, band: <ScheduledBand />, atBottom: true })
  expect(button.disabled).toBe(true)
  expect(getComputedStyle(button).visibility).toBe('hidden')
})
