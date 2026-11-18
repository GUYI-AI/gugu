import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view'
import { loadChatUi } from '@renderer/lib/chat/chat-transcript'
import { LocalizationProvider } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/session/renderer/features/assistant/assistant-today.css'
import '@/mobile/phone-look.css'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  root?.unmount()
  host?.remove()
  root = null
  host = null
})

// owner 10-28 手机试用:多打几行,输入框被 9999px 圆角压成了一个圆。
it('a multi-line phone composer grows into a rounded rectangle, not a circle', async () => {
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = 'width:370px'
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat />
    </LocalizationProvider>,
  )
  await until('the phone composer has mounted', () => !!host?.querySelector('[data-slot="composer"][data-mobile] [contenteditable]'))
  const box = host.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const radius = () => Number.parseFloat(getComputedStyle(box).borderTopLeftRadius)
  const oneLine = box.getBoundingClientRect().height
  expect(radius(), 'one line is still a capsule').toBeGreaterThanOrEqual(oneLine / 2 - 1)

  await page.getByTestId('chat-composer').fill('一\n二\n三\n四\n五')
  await until('five lines grow the composer', () => box.getBoundingClientRect().height > oneLine * 2)
  const { height, width } = box.getBoundingClientRect()
  expect(radius()).toBeLessThan(height / 4)
  expect(width, 'the box keeps its width while it grows').toBeGreaterThan(height)
})

function rgbOf(css: string): number[] {
  const srgb = css.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/)
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])]
  const m = css.match(/rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)/)
  if (!m) throw new Error(`unparsed color: ${css}`)
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
}
function contrast(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** 计算后的颜色的不透明度:rgb() = 1;rgba(..., a) / color(srgb ... / a) = a。 */
function alphaOf(css: string): number {
  const slash = css.match(/\/\s*([\d.]+)\s*\)$/)
  if (slash) return Number(slash[1])
  const rgba = css.match(/^rgba\([^)]*,\s*([\d.]+)\)$/)
  return rgba ? Number(rgba[1]) : 1
}

// owner 10-28 手机试用:输入框完全透明,后面滚过的消息和输入的字叠在一起。
// owner 11-17: the rows above the input float like desktop; only the input itself is backed.
it.each(['dark', 'light'] as const)('%s: the phone composer floats over messages and only the input is backed', async (theme) => {
  await page.viewport(390, 844)
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.setAttribute('data-ta-scope', '')
  host.style.cssText = 'position:relative;width:390px;height:600px;display:flex;flex-direction:column;overflow:hidden;background:var(--ta-app-bg);color:var(--text-primary)'
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <div data-test-messages="" data-chat-dock-reads="" style={{ flex: 1, minHeight: 0, overflow: 'auto', fontSize: 40, lineHeight: '48px' }}>{Array.from({ length: 14 }, (_, index) => <p key={index}>消息 message {index}</p>)}</div>
      <ChatBottomDock reserve={false}>
        <div data-chat-composer="" style={{ padding: '8px 8px max(8px, env(safe-area-inset-bottom))' }}>
          <ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat />
        </div>
      </ChatBottomDock>
    </LocalizationProvider>,
  )
  await until('the phone composer has mounted', () => !!host?.querySelector('[data-slot="composer"][data-mobile] [contenteditable]'))
  const dock = host.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
  const input = host.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  expect(alphaOf(getComputedStyle(input).backgroundColor), 'the input itself is opaque').toBe(1)
  const bar = host.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
  const band = getComputedStyle(bar, '::before')
  expect(alphaOf(band.backgroundColor), 'the input is backed').toBeGreaterThanOrEqual(0.85)
  expect(Number.parseFloat(band.top), 'the backing starts at the input, not at the rows above it').toBe(0)
  expect(Number.parseFloat(band.height)).toBeGreaterThan(input.getBoundingClientRect().height)
  expect(alphaOf(getComputedStyle(dock.lastElementChild!, '::before').backgroundColor), 'the dock row itself is not backed').toBe(0)
  const list = host.querySelector<HTMLElement>('[data-test-messages]')!
  expect(getComputedStyle(dock).position, 'the phone dock floats like desktop').toBe('absolute')
  await until('the list reserves the measured dock height', () => Number.parseFloat(getComputedStyle(list).getPropertyValue('--chat-dock-h')) === dock.offsetHeight)
  expect(list.getBoundingClientRect().bottom, 'messages run under the floating dock').toBe(host.getBoundingClientRect().bottom)
  await page.getByTestId('chat-composer').fill('Typed text stays readable')
  const editor = host.querySelector<HTMLElement>('[contenteditable]')!
  expect(contrast(rgbOf(getComputedStyle(editor).color), rgbOf(getComputedStyle(input).backgroundColor)), 'the typed text reads on the input').toBeGreaterThanOrEqual(4.5)
  list.scrollTop = list.scrollHeight
  await page.screenshot({ path: `phone-composer-backing-${theme}.png` })
})


it.each(['dark', 'light'] as const)('%s: the shared agent composer keeps phone glass separate from the desktop fade', async (theme) => {
  await page.viewport(390, 844)
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  const { createChatContext, createChatState } = await loadChatUi()
  const context = createChatContext({ locale: () => 'en-US' })
  const state = createChatState(context)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.setAttribute('data-ta-scope', '')
  host.style.cssText = 'position:relative;width:390px;height:600px;overflow:hidden;background:var(--bg)'
  root = createRoot(host)
  try {
    root.render(
      <LocalizationProvider>
        <AgentConversationView context={context} state={state} composerPlacement="bottom"
          style={{ position: 'absolute', inset: 0 }}
          composerContent={<ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat />} />
      </LocalizationProvider>,
    )
    await until('the shared phone composer has mounted', () => !!host?.querySelector('[data-chat-composer-placement="bottom"] [contenteditable]'))
    const layer = host.querySelector<HTMLElement>('[data-chat-composer-placement="bottom"]')!
    const row = layer.lastElementChild!
    const band = getComputedStyle(row.querySelector('[data-slot="composer-bar"]')!, '::before')
    expect(band.content, 'the shared slot backs its input').toBe('""')
    expect(alphaOf(band.backgroundColor)).toBe(1)
    expect(Number.parseFloat(band.width), 'the backing covers the whole phone width').toBe(390)
    expect(getComputedStyle(row, '::before').content, 'the rows above the input stay see-through').toBe('none')
    expect(row.getBoundingClientRect().height).toBeGreaterThan(0)
    host.removeAttribute('data-phone-shell')
    const desktopFade = getComputedStyle(row, '::before')
    expect(desktopFade.backdropFilter, 'desktop has no phone glass').toBe('none')
    expect(alphaOf(desktopFade.backgroundColor), 'desktop has no solid full-row backing').toBe(0)
    expect(desktopFade.backgroundImage).toContain('linear-gradient')
    expect(Number.parseFloat(desktopFade.width)).toBe(row.getBoundingClientRect().width)
  } finally {
    root.unmount()
    root = null
    state.dispose()
    context.dispose()
  }
})

it.each([320, 390])('keeps permission, model and attachment controls separate on a %ipx agent composer', async (width) => {
  await page.viewport(width, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = `width:${width}px`
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <div data-agent-conversation=""><ChatMessageComposer onSend={vi.fn(async () => {})} conversation={{
        permissionModeOptions: { full: { name: '完全访问' } }, selectedPermissionMode: 'full',
        modelOptions: { default: { name: 'Default' } }, selectedModel: 'default',
      }} /></div>
    </LocalizationProvider>,
  )
  await until('the agent options have mounted', () => !!host?.querySelector('[data-slot="composer-permission-mode"]'))
  const permission = host.querySelector<HTMLElement>('[data-slot="composer-permission-mode"]')!.closest('button')!
  const attach = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="composer-actions-start"] > button')].find(button => button !== permission)!
  const input = host.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const model = host.querySelector<HTMLElement>('[data-testid="composer-model-trigger"]')!
  const inputEditor = input.querySelector<HTMLElement>('[contenteditable]')!
  ;(inputEditor as HTMLElement & { editor: { commands: { setContent: (html: string) => void } } }).editor.commands.setContent('<p>第一行</p><p>第二行</p>')
  await until('two-line attachment moves beside the send button', () => attach.getBoundingClientRect().left >= inputEditor.getBoundingClientRect().right)
  const controls = [permission, attach, model]
  for (const [index, control] of controls.entries()) {
    const box = control.getBoundingClientRect()
    expect(box.width).toBeGreaterThan(0)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(width)
    for (const other of controls.slice(index + 1)) {
      const next = other.getBoundingClientRect()
      const overlap = Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1
        && Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1
      expect(overlap, 'each option and the attachment button keeps its own visible target').toBe(false)
    }
  }
  const editor = input.querySelector<HTMLElement>('[contenteditable]')!.getBoundingClientRect()
  expect(editor.right).toBeLessThanOrEqual(attach.getBoundingClientRect().left)
  expect(editor.right).toBeLessThanOrEqual(input.getBoundingClientRect().right - 44)
})
