import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { NoticeHost } from '@/components/NoticeHost'
import { notify, dismissNotice } from '@/lib/notices'
import { readThemePreference, writeThemePreference } from '@renderer/lib/theme/host-theme'
import { clickElement, createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

let harness: ReturnType<typeof createReactHarness>
let previousTheme: ReturnType<typeof readThemePreference> = 'light'
afterEach(() => { dismissNotice('card-edge'); dismissNotice('first-install-card'); harness?.cleanup(); if (previousTheme) writeThemePreference(previousTheme) })

it.each(['light', 'dark'] as const)('paints the real notice lower outline and safe-gap shadow in %s theme', async theme => {
  await page.viewport(1000, 700)
  previousTheme = readThemePreference()
  writeThemePreference(theme)
  harness = createReactHarness()
  await harness.render(<><NoticeHost />
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)' }}>
      <div data-slot="composer" style={{ position: 'absolute', left: 200, right: 24, bottom: 8, height: 110 }}>
        <textarea aria-label="Message" style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  </>)
  await act(async () => { notify({ key: 'card-edge', title: '群文件存储空间已满（1.00 GB / 1.00 GB），暂时无法上传新文件。', tier: 'warning', duration: 60_000, action: { label: '管理文件', onClick() {} } }) })
  const card = () => document.querySelector<HTMLElement>('[data-sonner-toast]')!
  const composer = document.querySelector<HTMLElement>('[data-slot="composer"]')!
  await until('card settles at the approved 8px gap', () => !!card() && Math.abs(composer.getBoundingClientRect().top - card().getBoundingClientRect().bottom - 8) < 0.01)
  await document.fonts.ready
  await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  const box = card().getBoundingClientRect()
  const shot = await page.screenshot({ path: `__screenshots__/notice-card-edge/${theme}.png`, base64: true })
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot.base64}`)).blob())
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width; canvas.height = bitmap.height
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  const scale = bitmap.width / innerWidth
  const pixel = (x: number, y: number) => [...context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data].slice(0, 3)
  const background = pixel(10, box.bottom)
  const lowerOutline = pixel(box.left + box.width / 2, box.bottom)
  const lowerShadow = pixel(box.left + box.width / 2, box.bottom + 3)
  bitmap.close()
  // The production outline is a half-pixel shadow outside the card's border box.
  // A clip ending exactly at that box deletes it and all shadow below it.
  expect(lowerOutline).not.toEqual(background)
  expect(lowerShadow).not.toEqual(background)
  expect(composer.getBoundingClientRect().top - box.bottom).toBeCloseTo(8, 2)
})

it('persistent notices take the one banner slot on top of the content column: one shown, the page and its close button below it, a dialog over it', async () => {
  await page.viewport(1000, 700)
  previousTheme = readThemePreference()
  harness = createReactHarness()
  const pageClosed = vi.fn(), dialogClosed = vi.fn()
  await harness.render(<><NoticeHost />
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <header style={{ height: 40, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '0 12px' }}>
          <button type="button" aria-label="Close page" onClick={pageClosed} style={{ width: 28, height: 28 }} />
        </header>
        <div data-slot="composer" style={{ position: 'absolute', left: 24, right: 24, bottom: 8, height: 110 }} />
      </div>
    </div>
  </>)
  await act(async () => {
    notify({ key: 'first-install-card', title: '咕咕 支持一键数据导入啦', description: '快速带入你的记忆、项目规则和工作习惯', ongoing: true, action: { label: '导入', onClick() {} } })
    notify({ key: 'card-edge', title: '群文件存储空间已满,暂时无法上传新文件。', tier: 'warning', ongoing: true, action: { label: '管理文件', onClick() {} } })
  })
  const banners = () => document.querySelectorAll<HTMLElement>('.gugu-notice-card')
  expect(banners()).toHaveLength(1)
  expect(banners()[0]!.textContent).toContain('2/2')
  expect(document.querySelector('[data-sonner-toast]')).toBeNull()
  // In the flow: the page (its header and close button) starts below the banner, nothing overlaps.
  const close = () => document.querySelector<HTMLButtonElement>('[aria-label="Close page"]')!
  expect(close().getBoundingClientRect().top).toBeGreaterThanOrEqual(banners()[0]!.getBoundingClientRect().bottom)
  await clickElement(close())
  expect(pageClosed).toHaveBeenCalledOnce()
  // Paging shows the other one in the same place.
  await clickElement(banners()[0]!.querySelector<HTMLButtonElement>('.gugu-notice-pager button')!)
  expect(banners()[0]!.textContent).toContain('1/2')
  // A settings-style dialog opens over the page: the banner is under it, its close button is reachable.
  await harness.render(<><NoticeHost />
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}><div style={{ flex: 1 }} /></div>
    <div role="dialog" style={{ position: 'fixed', inset: '32px 0', zIndex: 'var(--z-settings)', background: 'var(--bg-primary)' }}>
      <button type="button" aria-label="Close settings" onClick={dialogClosed} style={{ position: 'absolute', top: 16, right: 16, width: 32, height: 32 }} />
    </div>
  </>)
  const settingsClose = document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.getBoundingClientRect()
  expect(document.elementFromPoint(settingsClose.left + settingsClose.width / 2, settingsClose.top + settingsClose.height / 2)?.getAttribute('aria-label')).toBe('Close settings')
  await clickElement(document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!)
  expect(dialogClosed).toHaveBeenCalledOnce()
})
