// @vitest-environment jsdom
//
// #6791 / #6794 手机上右侧栏那一槽位是一整页:撑满宽、盖住会话页头,安卓返回键先关它(桌面不渲染它)。
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../../support/testHarness'

const { RightPanel } = await import('../../../../../apps/desktop/src/components/chat/RightPanel')
const { NATIVE_BACK_EVENT } = await import('../../../../../apps/desktop/src/components/ui/sheetStack')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const nativeBack = (): boolean => {
  const w = window as Window & { __guguNativeBackHandled?: boolean }
  w.__guguNativeBackHandled = false
  window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT))
  return Boolean((window as Window & { __guguNativeBackHandled?: boolean }).__guguNativeBackHandled)
}

describe('RightPanel', () => {
  it('手机:整页撑满、返回键关它', async () => {
    const onClose = vi.fn()
    await harness.render(createElement(RightPanel, { testId: 'panel', onClose, children: createElement('div', null, 'body') }))
    const panel = harness.container.querySelector('[data-testid="panel"]') as HTMLElement
    expect(panel.style.position).toBe('fixed')
    expect(panel.style.width).toBe('100%')
    expect(nativeBack()).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
