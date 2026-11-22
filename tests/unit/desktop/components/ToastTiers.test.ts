// @vitest-environment jsdom
import { createElement, isValidElement, useContext, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sonner = vi.hoisted(() => {
  const base = vi.fn((_title: unknown, _options?: unknown) => 'id')
  return Object.assign(base, {
    success: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    error: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    warning: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    info: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    dismiss: vi.fn(),
  })
})
vi.mock('sonner', () => ({ toast: sonner, Toaster: () => null }))
const noticeLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => noticeLog, hasRendererLogBridge: () => false }))

import { ToastProvider } from '../../../../apps/desktop/src/components/Toast'
import { ToastContext, type ToastType } from '../../../../apps/desktop/src/components/toastContext'
import { persistentNotices, dismissNotice, notify, useNotice } from '../../../../apps/desktop/src/lib/notices'
import { TOAST_DWELL_MS } from '../../../../apps/desktop/src/lib/toastTiers'
import { createReactHarness } from '../../../support/testHarness'

type Options = { id?: string; duration?: number; closeButton?: boolean; className?: string; icon?: unknown; description?: unknown; onDismiss?: () => void; onAutoClose?: () => void }
const lastOptions = (fn: ReturnType<typeof vi.fn>): Options => fn.mock.calls.at(-1)?.[1] as Options

beforeEach(() => {
  // The provider mounts the real NoticeHost, which reads the system theme; jsdom has no media queries.
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })))
  for (const fn of [sonner, sonner.success, sonner.error, sonner.warning, sonner.info, sonner.dismiss, noticeLog.warn]) fn.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

describe('提示的档位与停留(全 app 一份,#4891 / #137)', () => {
  it.each<[ToastType, number]>([
    ['success', TOAST_DWELL_MS.success],
    ['info', TOAST_DWELL_MS.info],
    ['warning', TOAST_DWELL_MS.warning],
    ['error', TOAST_DWELL_MS.error],
  ])('%s 按自己的档位停留 %ims', (tier, dwell) => {
    notify({ title: 'boom', tier })
    expect(sonner[tier]).toHaveBeenCalledTimes(1)
    expect(lastOptions(sonner[tier]).duration).toBe(dwell)
  })

  it('warning 是独立一档,不借用 error 的红(#4891)', () => {
    notify({ title: 'residue', tier: 'warning' })
    expect(sonner.warning).toHaveBeenCalledTimes(1)
    expect(sonner.error).not.toHaveBeenCalled()
  })

  it('失败 / 告警带关闭钮 —— 要读要复制的,挡路时能当场关;成功 / 提示没有', () => {
    for (const tier of ['error', 'warning'] as const) {
      notify({ title: tier, tier })
      expect(lastOptions(sonner[tier]).closeButton, tier).toBe(true)
    }
    for (const tier of ['success', 'info'] as const) {
      notify({ title: tier, tier })
      expect(lastOptions(sonner[tier]).closeButton, tier).toBe(false)
    }
  })

  it('转瞬的成功 / 提示点击穿透,别挡住下面的按钮一个停留周期;带动作的、要读的不穿透', () => {
    notify({ title: 'ok', tier: 'success' })
    notify({ title: 'fyi', tier: 'info' })
    expect(lastOptions(sonner.success).className).toBe('gugu-notice-passthrough')
    expect(lastOptions(sonner.info).className).toBe('gugu-notice-passthrough')
    notify({ title: 'undo?', tier: 'success', action: { label: '撤销', onClick: () => {} } })
    notify({ title: 'bad', tier: 'error' })
    expect(lastOptions(sonner.success).className).toBeUndefined()
    expect(lastOptions(sonner.error).className).toBeUndefined()
  })

  it('没给档位的旧调用一字不变:default 走裸 toast,destructive 走 error', () => {
    notify({ title: 'plain' })
    expect(sonner).toHaveBeenCalledWith('plain', expect.not.objectContaining({ duration: expect.anything() }))
    notify({ title: 'failed', variant: 'destructive' })
    expect(sonner.error).toHaveBeenCalledWith('failed', expect.anything())
  })
})

describe('同 key 是同一条:原地更新,不叠(转瞬的提示条)', () => {
  it('同 key 活着时是同一个 sonner id(原地更新);不给 key 就是一次性的新提示', () => {
    notify({ key: 'machine:d1', title: '正在重新连接 Mac 1', tier: 'error' })
    notify({ key: 'machine:d1', title: '连不上 Mac 1', tier: 'error' })
    const [first, second] = sonner.error.mock.calls.map((call) => (call[1] as Options).id)
    expect(first).toMatch(/^machine:d1#/)
    expect(second).toBe(first)
    notify({ title: 'one-off', tier: 'info' })
    expect(lastOptions(sonner.info).id).toBeUndefined()
  })

  it('一条结束了(被收 / 被关 / 到点),同 key 再发是新的一条:❌ 被排到下一帧的那次收顺手杀掉、❌ 继承上一条的字段', () => {
    notify({ key: 'machine:d2', title: '离线', tier: 'error' })
    const first = lastOptions(sonner.error).id
    dismissNotice('machine:d2')
    expect(sonner.dismiss).toHaveBeenCalledWith(first)
    notify({ key: 'machine:d2', title: '离线', tier: 'error' })
    const second = lastOptions(sonner.error).id
    expect(second).not.toBe(first)
    ;(lastOptions(sonner.error) as { onDismiss: () => void }).onDismiss()
    notify({ key: 'machine:d2', title: '离线', tier: 'error' })
    expect(lastOptions(sonner.error).id).not.toBe(second)
  })

  it('retires an expired keyed notice before notifying its owner', () => {
    const expired = vi.fn(() => notify({ key: 'expiry-callback', title: 'new notice', tier: 'error' }))
    notify({ key: 'expiry-callback', title: 'first notice', tier: 'error', onAutoClose: expired })
    const old = lastOptions(sonner.error)
    old.onAutoClose?.()
    expect(expired).toHaveBeenCalledTimes(1)
    expect(lastOptions(sonner.error).id).not.toBe(old.id)
  })

  it('onDismiss 只在用户亲手关时回调:dismissNotice 收掉的那条,sonner 晚一帧的回调 ❌ 算用户关的', () => {
    const closedByUser = vi.fn()
    notify({ key: 'machine:d4', title: '离线', tier: 'error', onDismiss: closedByUser })
    const appDismissed = lastOptions(sonner.error) as { onDismiss: () => void }
    dismissNotice('machine:d4')
    notify({ key: 'machine:d4', title: '离线', tier: 'error', onDismiss: closedByUser })
    appDismissed.onDismiss()
    expect(closedByUser).not.toHaveBeenCalled()
    ;(lastOptions(sonner.error) as { onDismiss: () => void }).onDismiss()
    expect(closedByUser).toHaveBeenCalledTimes(1)
  })

  it('dismissNotice 按 key 收掉活着的那一条;没有这条就什么都不做', () => {
    notify({ key: 'machine:d3', title: '离线', tier: 'error' })
    const id = lastOptions(sonner.error).id
    dismissNotice('machine:d3')
    expect(sonner.dismiss).toHaveBeenCalledWith(id)
    sonner.dismiss.mockClear()
    dismissNotice('machine:d3')
    dismissNotice('machine:never')
    expect(sonner.dismiss).not.toHaveBeenCalled()
  })
})

describe('常驻的进右上角那一叠(owner 选的 B):位置只由寿命决定', () => {
  afterEach(() => { for (const banner of persistentNotices.read()) dismissNotice(banner.key) })
  const keys = () => persistentNotices.read().map((banner) => banner.key)

  it('ongoing 进那一叠、❌ 进提示条;同 key 原地更新,不叠', () => {
    notify({ key: 'machine:b1', title: '正在重新连接 Mac 1', tier: 'info', ongoing: true, waiting: true })
    notify({ key: 'machine:b1', title: '连不上 Mac 1', tier: 'info', ongoing: true })
    expect(sonner.info).not.toHaveBeenCalled()
    expect(persistentNotices.read()).toMatchObject([{ key: 'machine:b1', title: '连不上 Mac 1' }])
  })

  it('一件事从常驻变转瞬(或反过来)只换位置:原处那条收掉,不回调 onDismiss', () => {
    const closedByUser = vi.fn()
    notify({ key: 'machine:b2', title: '离线', tier: 'info', ongoing: true, onDismiss: closedByUser })
    notify({ key: 'machine:b2', title: '已连接', tier: 'success' })
    expect(keys()).not.toContain('machine:b2')
    expect(lastOptions(sonner.success).id).toMatch(/^machine:b2#/)
    notify({ key: 'machine:b2', title: '又断了', tier: 'info', ongoing: true })
    expect(sonner.dismiss).toHaveBeenCalledWith(lastOptions(sonner.success).id)
    expect(keys()).toContain('machine:b2')
    expect(closedByUser).not.toHaveBeenCalled()
  })

  it('按进来的先后排;在铃铛里清掉 = 回调 onDismiss,dismissNotice 收 = 不回调', () => {
    const closed = vi.fn()
    notify({ key: 'b3', title: 'first', ongoing: true, onDismiss: closed })
    notify({ key: 'b4', title: 'second', ongoing: true, onDismiss: closed })
    notify({ key: 'b3', title: 'first, updated', ongoing: true, onDismiss: closed })
    expect(keys()).toEqual(['b3', 'b4'])
    dismissNotice('b4')
    expect(closed).not.toHaveBeenCalled()
    persistentNotices.clear('b3')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(keys()).toEqual([])
  })

  it('waiting 的图标是产品唯一的加载态组件,❌ 另画 spinner(转瞬的同一条规则)', () => {
    notify({ key: 'k', title: 'wait', tier: 'info', waiting: true })
    expect(isValidElement(lastOptions(sonner.info).icon)).toBe(true)
  })

  it('useNotice:给一条 = 在(原地更新),给 null / 卸载 = 收掉', async () => {
    function Owner({ title }: { title: string | null }) { useNotice('live', title ? { title, ongoing: true } : null); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Owner, { title: 'Installing' }))
    await harness.render(createElement(Owner, { title: 'Installed' }))
    expect(persistentNotices.read()).toMatchObject([{ key: 'live', title: 'Installed' }])
    await harness.render(createElement(Owner, { title: null }))
    expect(keys()).toEqual([])
    await harness.render(createElement(Owner, { title: 'Again' }))
    harness.cleanup()
    expect(keys()).toEqual([])
  })

  it('「以后再说」= 收进铃铛:还在、标成 deferred,不回调 onDismiss;之后同 key 更新也还在铃铛里', () => {
    const closed = vi.fn()
    notify({ key: 'install', title: 'Installing 10%', ongoing: true, onDismiss: closed })
    persistentNotices.defer('install')
    expect(persistentNotices.read()).toMatchObject([{ key: 'install', deferred: true }])
    notify({ key: 'install', title: 'Installing 60%', ongoing: true, onDismiss: closed })
    expect(persistentNotices.read()).toMatchObject([{ key: 'install', title: 'Installing 60%', deferred: true }])
    expect(closed).not.toHaveBeenCalled()
    persistentNotices.clear('install')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(keys()).toEqual([])
  })

  it('dismissible:false 的常驻收不进铃铛,只由它的结果收掉', () => {
    notify({ key: 'must-resolve', title: 'Resolve me', tier: 'warning', ongoing: true, dismissible: false })
    persistentNotices.defer('must-resolve')
    expect(persistentNotices.read()).toMatchObject([{ key: 'must-resolve', dismissible: false, deferred: false }])
  })

  it('不自己消失的转瞬(定时提醒)在提示条上,一定带关闭钮', () => {
    notify({ key: 'meeting', title: 'Design review', duration: Infinity })
    expect(lastOptions(sonner)).toMatchObject({ duration: Infinity, closeButton: true })
    expect(keys()).toEqual([])
  })
})

describe('主 app 的 toast(message, type) 入口', () => {
  let harness: ReturnType<typeof createReactHarness>
  afterEach(() => harness.cleanup())

  it('不改调用点,落到同一个出口、同一套档位', async () => {
    harness = createReactHarness()
    function Emit({ type }: { type: ToastType }) {
      const { toast } = useContext(ToastContext)
      useEffect(() => { toast('主 app 的提示', type, 'Clipboard write permission denied') }, [toast, type])
      return null
    }
    for (const type of ['success', 'info', 'warning', 'error'] as const) {
      await harness.render(createElement(ToastProvider, null, createElement(Emit, { type })))
      expect(sonner[type], type).toHaveBeenCalledWith('主 app 的提示', expect.objectContaining({ duration: TOAST_DWELL_MS[type], description: 'Clipboard write permission denied' }))
    }
  })
})

describe('用户读到的失败 / 告警落盘', () => {
  it('error、warning、destructive 记下原文,success / info 不记', () => {
    notify({ tier: 'error', key: 'k', title: '发送失败', description: '网络断了' })
    notify({ tier: 'warning', title: '部分没保存' })
    notify({ variant: 'destructive', title: '删不掉' })
    notify({ tier: 'success', title: '已保存' })
    notify({ tier: 'info', title: '提示' })
    expect(noticeLog.warn.mock.calls).toEqual([
      [{ tier: 'error', key: 'k', title: '发送失败', description: '网络断了' }, 'notice shown'],
      [{ tier: 'warning', key: undefined, title: '部分没保存', description: undefined }, 'notice shown'],
      [{ tier: 'error', key: undefined, title: '删不掉', description: undefined }, 'notice shown'],
    ])
  })
})


it('no transient notice picks its own corner: every one lands in the single toast outlet', () => {
  notify({ key: 'one-stack', title: 'Copied', tier: 'success', duration: 1500 })
  expect(lastOptions(sonner.success)).not.toHaveProperty('position')
  expect(lastOptions(sonner.success).closeButton).toBe(false)
})
