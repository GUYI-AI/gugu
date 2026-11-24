/**
 * #5707 侧栏行尾键帽:静止不画、悬浮才淡入 —— 真 Chromium、真 CSS、真组件。
 *
 * 页脚行用键帽表达快捷键，顶栏搜索图标则用普通提示浮层。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { appSettingsModel, LOCAL_SETTINGS_HOST_KEY } from '@renderer/features/settings/app-settings-client'

// 搜索行点下去打开 ⌘K 那个面板(弹窗注册表会把整棵 app-state 建起来,那些要 IPC)—— 这条测试只量键帽,给一个不开窗的替身。
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {} }))

import {
  SidebarMenu,
  SidebarMenuButton,
  sidebarRowContentInsetX,
  sidebarRowShortcutClass,
} from '@renderer/features/sidebar/sidebar-primitives'
import { SidebarSearchTrigger } from '@renderer/features/sidebar/sidebar-search-trigger'
import { commandRegistry } from '@renderer/lib/commands/registry'
import { BoundShortcut } from '@renderer/lib/ui/shortcut'
import { Tooltip } from '@/components/ui/Tooltip'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { cn } from '@renderer/utils/utils'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement
let pointerPark: HTMLElement

beforeEach(async () => {
  // This device's keyboard settings, read: no custom bindings (the shortcut labels are drawn only once they are read).
  appSettingsModel.set(['keyboard', LOCAL_SETTINGS_HOST_KEY], { value: {}, defaults: {}, overrides: {} })
  host = document.createElement('div')
  // 主题变量挂在 emlight/emdark 上(lib/theme/host-theme.ts);少了它键帽的边框与底色算不出来。
  // 宽度取侧栏常规宽,行才按产品里的样子排。
  host.className = 'gugu-skin emlight'
  host.style.width = '260px'
  document.body.append(host)
  root = createRoot(host)
  // 真指针跨用例保留坐标；必须在挂载之前挪开，否则「静止态」可能已经开始淡入。
  pointerPark = park()
  await userEvent.hover(pointerPark)
})

afterEach(() => {
  root.unmount()
  host.remove()
  pointerPark.remove()
})

function mount(): void {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <Tooltip.Provider>
          <SidebarMenu>
            <SidebarSearchTrigger />
            <SidebarMenuButton aria-label="settings-like" className="group/row w-full justify-between">
              <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
                <span className="truncate">设置</span>
              </span>
              <BoundShortcut commandId="app.settings" variant="keycaps" className={sidebarRowShortcutClass} />
            </SidebarMenuButton>
          </SidebarMenu>
        </Tooltip.Provider>
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

async function settingsKeycap(): Promise<HTMLElement> {
  await until('settings keycap mounted', () => host.querySelectorAll('[data-slot="shortcut"]').length === 1)
  return host.querySelector<HTMLElement>('[data-slot="shortcut"]')!
}

const opacityOf = (el: HTMLElement): number => Number.parseFloat(getComputedStyle(el).opacity)

/** 一块谁也不挡的角落,用来把真指针挪出侧栏(它跨用例留在原地)。 */
function park(): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;right:0;bottom:0;width:120px;height:120px'
  document.body.append(el)
  return el
}

/** 等过渡落定再量 —— 键帽走的是 --dur-fast 那一档,量在半路会读到中间值。 */
async function settledOpacity(el: HTMLElement, expected: number): Promise<void> {
  await until(`opacity settles at ${expected}`, () => Math.abs(opacityOf(el) - expected) < 0.005)
}

it('fades the settings keycap in on hover without moving it', async () => {
  mount()
  const cap = await settingsKeycap()
  const row = cap.closest('[data-slot="button"]') as HTMLElement
  const rest = cap.getBoundingClientRect()
  expect(rest.width).toBeGreaterThan(0)
  expect(opacityOf(cap)).toBe(0)

  await userEvent.hover(row)
  await settledOpacity(cap, 1)
  const hovered = cap.getBoundingClientRect()
  expect(hovered.left).toBeCloseTo(rest.left, 1)
  expect(hovered.width).toBeCloseTo(rest.width, 1)

  await userEvent.hover(pointerPark)
  await settledOpacity(cap, 0)
})

it('fades the settings keycap in when Tab reaches its row', async () => {
  mount()
  const cap = await settingsKeycap()
  const row = cap.closest('[data-slot="button"]') as HTMLElement
  await settledOpacity(cap, 0)

  const openPanel = vi.fn()
  const unregister = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', execute: openPanel }] })
  try {
    await page.getByTestId('sidebar-search-trigger').click()
  } finally {
    unregister()
  }
  expect(openPanel).toHaveBeenCalledOnce()
  await userEvent.keyboard('{Tab}')
  await until('Tab reaches the settings row', () => document.activeElement === row)
  await settledOpacity(cap, 1)
})

it('shows the search shortcut in the search field even in the narrow sidebar', async () => {
  // 界面减法 #46: the search is a field with 搜索 and its shortcut written in it, so the shortcut needs no tooltip.
  host.style.width = '200px'
  mount()
  await until('search field mounted', () => !!host.querySelector('[data-testid="sidebar-search-trigger"]'))
  const search = host.querySelector<HTMLElement>('[data-testid="sidebar-search-trigger"]')!
  expect(search.textContent?.trim()).toMatch(/^(?:Search|搜索)(?:⇧⌘F|Ctrl\+Shift\+F)$/)
  const cap = search.lastElementChild!.getBoundingClientRect()
  expect(cap.width).toBeGreaterThan(0)
  expect(cap.right).toBeLessThanOrEqual(search.getBoundingClientRect().right)
})
