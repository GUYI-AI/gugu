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
  await act(async () => { notify({ key: 'card-edge', title: '群文件存储空间已满（1.00 GB / 1.00 GB），暂时无法上传新文件。', tier: 'warning', ongoing: true, action: { label: '管理文件', onClick() {} } }) })
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

it('keeps a panel close button clickable under every persistent notice: the stack only grows from the bottom edge', async () => {
  await page.viewport(1000, 700)
  previousTheme = readThemePreference()
  harness = createReactHarness()
  const closed = vi.fn()
  // A settings-sized panel: its close button sits in its own top edge, like every sheet and dialog.
  await harness.render(<><NoticeHost />
    <div role="dialog" style={{ position: 'fixed', inset: '32px 0', zIndex: 'var(--z-settings)', background: 'var(--bg-primary)' }}>
      <button type="button" aria-label="Close settings" onClick={closed} style={{ position: 'absolute', top: 16, right: 16, width: 32, height: 32 }} />
    </div>
  </>)
  await act(async () => {
    notify({ key: 'first-install-card', title: '咕咕 支持一键数据导入啦', description: '快速带入你的记忆、项目规则和工作习惯', ongoing: true, action: { label: '导入', onClick() {} } })
    notify({ key: 'card-edge', title: '群文件存储空间已满,暂时无法上传新文件。', tier: 'warning', ongoing: true, action: { label: '管理文件', onClick() {} } })
  })
  await until('both notices are mounted', () => document.querySelectorAll('[data-sonner-toast]').length === 2)
  // One list, one corner: no notice opened a second position.
  expect(document.querySelectorAll('[data-sonner-toaster]')).toHaveLength(1)
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.getBoundingClientRect()
  expect(document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2)?.getAttribute('aria-label')).toBe('Close settings')
  await clickElement(document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!)
  expect(closed).toHaveBeenCalledOnce()
})
