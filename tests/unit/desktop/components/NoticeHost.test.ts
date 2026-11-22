// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }), Toaster: () => createElement('div', { 'data-testid': 'toaster' }) }))

import { NoticeHost } from '../../../../apps/desktop/src/components/NoticeHost'
import { createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
const toasters = () => harness.container.querySelectorAll('[data-testid="toaster"]').length
const holder = () => document.documentElement.dataset.noticeHost?.split(':')[0]
const host = (key: string, embedded = false) => createElement(NoticeHost, { key, embedded })
const render = (...hosts: Array<ReturnType<typeof host>>) => harness.render(createElement(Fragment, null, ...hosts))

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })))
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.unstubAllGlobals()
})

// sonner 的状态全窗口一份:同一个文档里挂两个宿主,每条提示就会画两遍;一个都没有,提示就凭空消失。
describe('提示条的宿主:同一个文档里一次只有一个在画(#137)', () => {
  it('主 app 与会话页各挂一个:只画一份', async () => {
    await render(host('app'), host('session', true))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('app')
  })

  it('会话页先挂上,主 app 的宿主后到:从它手里接过来,❌ 提示条留在一个看不见的宿主里', async () => {
    await render(host('session', true))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('embedded')
    await render(host('session', true), host('app'))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('app')
    // 它卸载后,会话页的立刻接上
    await render(host('session', true))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('embedded')
  })

  it('画的那个卸载了,留着的接着画;全卸载了认领也清空,下一个能再认领', async () => {
    await render(host('a'), host('b'))
    expect(toasters()).toBe(1)
    await render(host('b'))
    expect(toasters()).toBe(1)
    await render()
    expect(toasters()).toBe(0)
    expect(document.documentElement.dataset.noticeHost).toBeUndefined()
    await render(host('c'))
    expect(toasters()).toBe(1)
  })

  it('会话页单独成文档(没有主 app)时由它自己画', async () => {
    await render(host('session', true))
    expect(toasters()).toBe(1)
  })
})

// #3450 首装导入卡片是常驻的、钉在右上;设置 Sheet 的 ✕ 也在右上 —— 模态开着时它要让位(不盖、不接点击)。
describe('模态开着时首装导入卡片让位(#3450)', () => {
  const declared = (prop: string): string[] => {
    const values: string[] = []
    postcss.parse(readFileSync('apps/desktop/src/components/notice-host.css', 'utf8')).walkRules((rule) => {
      if (rule.selector.includes('[data-base-ui-inert]') && rule.selector.includes('gugu-notice-first-install-import')) {
        rule.walkDecls(prop, (decl) => { values.push(decl.value) })
      }
    })
    return values
  }
  it('the persistent card is hidden inside the subtree Base UI marks inert, and returns when the layer closes', () => {
    expect(declared('visibility'), 'an open modal marks the notice host inert; the card must not paint over or intercept its controls').toContain('hidden')
  })
})
