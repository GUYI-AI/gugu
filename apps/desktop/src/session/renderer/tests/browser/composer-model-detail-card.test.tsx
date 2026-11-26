import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { contextThresholdMinimum } from '@gugu/session-core/models/context-threshold'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { enUSMessages } from '@renderer/localization/messages'
// 主题层与同目录 composer-disabled-options 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
// 清单外那层滚动区(`.scroll-fade__viewport` 的 overflow)写在这份 CSS 里,app 由 embedded.tsx 引入:不引就量不到它滚。
import '@gugu/session-ui/styles/overflow-fade.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/** The model menu exposes one row per model, with settings in its detail card. */
const MODELS = {
  'opus': {
    name: 'Opus 5.5',
    groupLabel: '你的 Claude 模型',
    providerLabel: 'Anthropic',
    description: 'Best for everyday tasks',
    modelFeatures: { contextWindowSize: 1_000_000 },
  },
  'platform:glm-5.3-flash': {
    name: 'GLM 5.3 Flash',
    groupLabel: '咕咕模型按积分计费',
    providerLabel: '智谱',
    creditRate: '0.04x',
    modelFeatures: { contextWindowSize: 200_000 },
  },
  'platform:deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    groupLabel: '咕咕模型按积分计费',
    providerLabel: 'DeepSeek',
    description: '相对倍率 ×0.07',
    disabled: true,
    disabledReason: 'This provider does not support the required API',
  },
  'platform:gemini-3.8-flash': {
    name: 'Gemini 3.8 Flash',
    groupLabel: '咕咕模型按积分计费',
    providerLabel: 'Google',
    description: '相对倍率 ×0.19',
  },
}

/** 实机那份档位表的形状:带说明,所以读数行里有第三格。 */
const EFFORTS = {
  low: { name: '低', description: '快,适合简单的活' },
  high: { name: '高', description: '想得更久,适合难题' },
}

let root: Root | null = null
let container: HTMLDivElement | null = null
const onManageModels = vi.fn()
const onModelChange = vi.fn()

const panel = () => document.querySelector<HTMLElement>('[data-slot="combobox-content"]')
const detail = () => document.querySelector<HTMLElement>('[data-slot="composer-model-detail"]')
/** 清单外面那层滚动区(primitive 的 ScrollContainer):从清单往上找第一个能纵向滚的祖先。 */
const scrollArea = (): HTMLElement => {
  const list = panel()!.querySelector<HTMLElement>('[data-slot="combobox-list"]')!
  for (let el = list.parentElement; el; el = el.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(el).overflowY)) return el
  }
  throw new Error('the model list has no scroll area around it')
}
const rowByName = (name: string): HTMLElement =>
  ([...(panel()?.querySelectorAll('[data-slot="composer-model-name"]') ?? [])]
    .find((el) => el.textContent?.trim() === name)
    ?.closest('[role="option"]') as HTMLElement)

describe('模型面板:单行清单 · 悬浮详情卡 · 底部去路', () => {
  beforeEach(async () => {
    await page.viewport(1400, 800)
    onManageModels.mockReset()
    onModelChange.mockReset()
    container = document.createElement('div')
    container.className = 'emlight gugu-skin bg-background'
    container.style.cssText = 'position:fixed;right:24px;bottom:24px;width:640px'
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
    root.render(
      <SessionLocalizationProvider>
        <ChatComposer
          modelOptions={MODELS}
          selectedModel="platform:glm-5.3-flash"
          onModelChange={onModelChange}
          effortOptionsForModel={id => id === 'opus' ? EFFORTS : null}
          onManageModels={onManageModels}
          effortOptions={EFFORTS}
          selectedEffort="high"
          onEffortChange={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </SessionLocalizationProvider>
    )
    await until('composer model trigger mounted', () => document.querySelector('[data-testid="composer-model-trigger"]') != null)
    ;(document.querySelector('[data-testid="composer-model-trigger"]') as HTMLElement).click()
    await until('model panel lists options', () => (panel()?.querySelectorAll('[role="option"]').length ?? 0) > 0)
    // 入场动画还在移动按钮时,hover() 算出的坐标可能落到页脚。
    await until('model panel entry animation finishes', () => panel()!.getAnimations().every((animation) => animation.playState === 'finished'))
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('shows the model name and the rate on one line', () => {
    const row = rowByName('GLM 5.3 Flash')
    expect(row.querySelector('[data-slot="composer-model-rate"]')?.textContent).toBe('0.04x')
    expect(rowByName('Opus 5.5').textContent).not.toContain('Best for everyday tasks')
  })

  it('ends the flat list with a divider and the custom-model action', () => {
    expect(panel()!.querySelector('[data-testid="composer-model-search"]')).toBeNull()
    expect(panel()!.querySelector('[data-testid^="composer-model-provider-"]')).toBeNull()
    expect(panel()!.querySelector('[data-testid="composer-model-upgrade"]')).toBeNull()
    const scroller = scrollArea()
    const manage = panel()!.querySelector<HTMLElement>('[data-testid="composer-model-manage"]')!
    expect(scroller.contains(manage)).toBe(true)
    const rows = [...scroller.querySelectorAll<HTMLElement>('[role="option"], button')]
    expect(rows.at(-1)).toBe(manage)
    expect(rows.slice(0, -1).every(row => row.getAttribute('role') === 'option')).toBe(true)
    expect(manage.getBoundingClientRect().width).toBeCloseTo(rowByName('Opus 5.5').getBoundingClientRect().width, 0)
    const footer = panel()!.querySelector('[data-slot="composer-model-footer"]')!
    expect(getComputedStyle(footer).borderTopWidth).toBe('1px')
  })

  it('opens an explicit thinking submenu from the selected model detail', async () => {
    await page.elementLocator(rowByName('GLM 5.3 Flash')).hover()
    await until('detail card opens', () => detail() !== null)
    const thinking = detail()!.querySelector<HTMLButtonElement>('button')!
    await page.elementLocator(thinking).hover()
    await expect.element(page.getByRole('button', { name: '低', exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '高', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(page.getByRole('button', { name: 'Default', exact: true }).query()).toBeNull()
  })

  it('selects an unselected model and its thinking level from the left-opening submenu', async () => {
    const target = rowByName('Opus 5.5')
    await page.elementLocator(target).hover()
    await until('Opus detail opens', () => detail()?.textContent?.includes('Opus 5.5') === true)
    const thinking = detail()!.querySelector<HTMLButtonElement>('button')!
    await page.elementLocator(thinking).hover()
    const low = page.getByRole('button', { name: '低', exact: true })
    await expect.element(low).toBeVisible()
    const card = detail()!.closest('[data-hover-card]')!.getBoundingClientRect()
    const submenu = low.element().closest('[data-hover-card]')!.getBoundingClientRect()
    expect(submenu.right).toBeLessThanOrEqual(card.left + 1)
    await low.click()
    expect(onModelChange).toHaveBeenCalledExactlyOnceWith('opus', 'low')
    await until('model picker closes', () => panel() === null)
    await expect.element(page.getByTestId('composer-model-trigger')).toHaveFocus()
  })

  it('returns from the thinking options to the highlighted model and confirms with Enter', async () => {
    const opus = page.elementLocator(rowByName('Opus 5.5'))
    const low = page.getByRole('button', { name: '低', exact: true })
    const high = page.getByRole('button', { name: '高', exact: true })
    await expect.element(page.elementLocator(rowByName('GLM 5.3 Flash'))).toHaveFocus()
    await userEvent.keyboard('{Home}')
    await expect.element(opus).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(low).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    await expect.element(opus).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(low).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(high).toHaveFocus()
    expect(onModelChange).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onModelChange).toHaveBeenCalledExactlyOnceWith('opus', 'high')
    await until('model picker closes', () => panel() === null)
    await expect.element(page.getByTestId('composer-model-trigger')).toHaveFocus()
  })

  it('shows a rate and thinking in the card and hides a single context window', async () => {
    await page.elementLocator(rowByName('GLM 5.3 Flash')).hover()
    await until('detail card opens on hover', () => detail()?.textContent?.includes('GLM 5.3 Flash') === true)
    expect(detail()!.querySelector('[data-slot="composer-model-detail-rate"]')?.textContent).toContain('0.04x')
    expect(detail()!.querySelectorAll('button')).toHaveLength(1)
    expect(panel()).not.toBeNull()

    await page.elementLocator(rowByName('Opus 5.5')).hover()
    await until('detail card follows the pointer', () => detail()?.textContent?.includes('Opus 5.5') === true)
    expect(detail()!.textContent).toContain('Best for everyday tasks')
    expect(detail()!.querySelectorAll('button')).toHaveLength(1)
  })

  it('opens a disabled model’s reason on pointer hover and keeps the selection unchanged', async () => {
    const row = rowByName('DeepSeek V4 Flash')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    await page.elementLocator(row).hover()
    await until('disabled model detail card opens', () => detail()?.textContent?.includes('This provider does not support the required API') === true)
    row.click()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('closes the panel and hands off to settings from 「配置模型」', async () => {
    document.querySelector<HTMLElement>('[data-testid="composer-model-manage"]')!.click()
    expect(onManageModels).toHaveBeenCalledTimes(1)
    await until('panel closes', () => panel() === null)
  })
})

describe('The English custom-model action fits in the footer', () => {
  const en = (key: string, values: Readonly<Record<string, string | number>> = {}) =>
    String((enUSMessages as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))

  beforeEach(async () => {
    await page.viewport(1400, 800)
    container = document.createElement('div')
    container.className = 'emlight gugu-skin bg-background'
    container.style.cssText = 'position:fixed;right:24px;bottom:24px;width:640px'
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
    root.render(
      <MessageProvider locale="en-US" translate={en}>
        <ChatComposer
          modelOptions={MODELS}
          selectedModel="platform:glm-5.3-flash"
          onModelChange={() => {}}
          onManageModels={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </MessageProvider>
    )
    await until('composer model trigger mounted', () => document.querySelector('[data-testid="composer-model-trigger"]') != null)
    ;(document.querySelector('[data-testid="composer-model-trigger"]') as HTMLElement).click()
    await until('model panel lists options', () => (panel()?.querySelectorAll('[role="option"]').length ?? 0) > 0)
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('不被面板裁掉:按钮在底栏的内容区之内,字没有溢出按钮', () => {
    const manage = document.querySelector<HTMLElement>('[data-testid="composer-model-manage"]')!
    expect(manage.textContent).toBe('Configure custom models')
    const box = manage.getBoundingClientRect()
    // 判的是清单滚动区的内容区(右缘减去右内边距),❌ 只看面板:测试里字体比实机窄,旧写法也只伸进内边距、还没出面板;
    // 实机上同一份溢出就到了面板外被裁掉(#7123,约 19px)。
    const scroller = scrollArea()
    const contentRight = scroller.getBoundingClientRect().right - parseFloat(getComputedStyle(scroller).paddingRight)
    expect(box.right, '按钮伸出了清单的内容区').toBeLessThanOrEqual(contentRight + 0.5)
    expect(scroller.scrollWidth, '清单被它撑出了横向滚动').toBeLessThanOrEqual(scroller.clientWidth)
    expect(manage.scrollWidth, '字在按钮里被截断了').toBeLessThanOrEqual(manage.clientWidth)
    expect(document.querySelector('[data-testid="composer-model-manage"]')!.textContent).toBe('Configure custom models')
  })
})

describe('owner 11-25 21:35:行内左右对称、标签是胶囊、长名字只截名字', () => {
  // A 14px logo stand-in: the icon column is drawn only when some row has a logo, as in the product.
  const logo = <span style={{ display: 'block', width: 14, height: 14, background: '#888' }} />
  const ROWS = {
    'platform:glm': { name: 'GLM 5.3 Flash', providerLabel: '智谱', creditRate: '0.04x', icon: logo },
    'platform:ds': { name: 'DeepSeek V4 Flash', providerLabel: 'DeepSeek', creditRate: '0.07x', icon: logo },
    long: { name: 'A custom model whose name is far too long to fit in this panel', providerLabel: 'OpenAI', tag: 'example-relay', icon: logo },
  }

  beforeEach(async () => {
    await page.viewport(1400, 800)
    container = document.createElement('div')
    container.className = 'emlight gugu-skin bg-background'
    container.style.cssText = 'position:fixed;right:24px;bottom:24px;width:640px'
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
    root.render(
      <SessionLocalizationProvider>
        <ChatComposer modelOptions={ROWS} selectedModel="platform:glm" onModelChange={() => {}} onManageModels={() => {}}
          onSubmit={() => {}} onStop={() => {}} />
      </SessionLocalizationProvider>
    )
    await until('composer model trigger mounted', () => document.querySelector('[data-testid="composer-model-trigger"]') != null)
    ;(document.querySelector('[data-testid="composer-model-trigger"]') as HTMLElement).click()
    await until('model panel lists options', () => (panel()?.querySelectorAll('[role="option"]').length ?? 0) > 0)
    await until('model panel entry animation finishes', () => panel()!.getAnimations().every((animation) => animation.playState === 'finished'))
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('puts the logo as far from the left edge as the check is from the right, and keeps every rate in one column', () => {
    const box = panel()!.getBoundingClientRect()
    const rect = (row: HTMLElement, slot: string) => row.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!.getBoundingClientRect()
    const selected = rowByName('GLM 5.3 Flash')
    const left = rect(selected, 'composer-model-icon').left - box.left
    const right = box.right - rect(selected, 'composer-model-check').right
    expect(Math.abs(left - right), `logo ${left.toFixed(1)}px from the left, check ${right.toFixed(1)}px from the right`).toBeLessThanOrEqual(1)
    // An unselected row reserves only the narrow check column: its rate ends where the selected row's does.
    expect(rect(rowByName('DeepSeek V4 Flash'), 'composer-model-rate').right).toBeCloseTo(rect(selected, 'composer-model-rate').right, 0)
    // The 「配置模型」 row's icon sits in the model rows' icon column.
    const manage = panel()!.querySelector<HTMLElement>('[data-testid="composer-model-manage"] [aria-hidden="true"]')!
    expect(manage.getBoundingClientRect().left).toBeCloseTo(rect(selected, 'composer-model-icon').left, 0)
  })

  it('draws the tag as a capsule and truncates only the name', () => {
    const row = rowByName('A custom model whose name is far too long to fit in this panel')
    const name = row.querySelector<HTMLElement>('[data-slot="composer-model-name"]')!
    const tag = row.querySelector<HTMLElement>('[data-slot="composer-model-tag"]')!
    const style = getComputedStyle(tag)
    expect(style.borderTopWidth).toBe('1px')
    expect(parseFloat(style.borderTopLeftRadius)).toBeGreaterThanOrEqual(tag.getBoundingClientRect().height / 2)
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(name.scrollWidth, 'the long name is cut with an ellipsis').toBeGreaterThan(name.clientWidth)
    expect(tag.scrollWidth, 'the tag is whole').toBeLessThanOrEqual(tag.clientWidth)
    expect(tag.textContent).toBe('example-relay')
    expect(tag.getBoundingClientRect().right).toBeLessThanOrEqual(row.getBoundingClientRect().right)
  })
})

describe('owner 11-25:「配置模型」跟着清单滚,❌ 钉在面板底上', () => {
  // 二十条:比 18rem 的滚动区长得多,才看得出它是钉着还是跟着滚。
  const logo = <span style={{ display: 'block', width: 14, height: 14, background: '#888' }} />
  const LONG = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`m${i}`, { name: `Model ${i + 1}`, providerLabel: 'OpenAI', icon: logo }])
  )

  beforeEach(async () => {
    await page.viewport(1400, 800)
    container = document.createElement('div')
    container.className = 'emlight gugu-skin bg-background'
    container.style.cssText = 'position:fixed;right:24px;bottom:24px;width:640px'
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
    root.render(
      <SessionLocalizationProvider>
        <ChatComposer modelOptions={LONG} selectedModel="m0" onModelChange={() => {}} onManageModels={() => {}}
          onSubmit={() => {}} onStop={() => {}} />
      </SessionLocalizationProvider>
    )
    await until('composer model trigger mounted', () => document.querySelector('[data-testid="composer-model-trigger"]') != null)
    ;(document.querySelector('[data-testid="composer-model-trigger"]') as HTMLElement).click()
    await until('model panel lists options', () => (panel()?.querySelectorAll('[role="option"]').length ?? 0) > 0)
    await until('model panel entry animation finishes', () => panel()!.getAnimations().every((animation) => animation.playState === 'finished'))
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('keeps the logo and the check equally far from the edges while the list scrolls (a scrollbar may take room)', () => {
    const box = panel()!.getBoundingClientRect()
    const row = panel()!.querySelector<HTMLElement>('[role="option"]')!
    const left = row.querySelector('[data-slot="composer-model-icon"]')!.getBoundingClientRect().left - box.left
    const right = box.right - row.querySelector('[data-slot="composer-model-check"]')!.getBoundingClientRect().right
    expect(Math.abs(left - right), `logo ${left.toFixed(1)}px from the left, check ${right.toFixed(1)}px from the right`).toBeLessThanOrEqual(1)
  })

  it('is below the fold while the list is at the top, and the last thing once it is scrolled to the end', async () => {
    const scroller = scrollArea()
    const manage = panel()!.querySelector<HTMLElement>('[data-testid="composer-model-manage"]')!
    // 阳性对照:真的长到要滚 —— 否则「在可视区外」平凡为假、「滚到底看得到」平凡为真。
    expect(scroller.scrollHeight, '清单没长到要滚').toBeGreaterThan(scroller.clientHeight + 100)
    expect(scroller.scrollTop).toBe(0)
    expect(manage.getBoundingClientRect().top, '「配置模型」钉在了可视区里').toBeGreaterThanOrEqual(scroller.getBoundingClientRect().bottom - 1)

    scroller.scrollTop = scroller.scrollHeight
    await until('scrolled to the end', () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1)
    const view = scroller.getBoundingClientRect()
    const row = manage.getBoundingClientRect()
    expect(row.top).toBeGreaterThanOrEqual(view.top)
    expect(row.bottom).toBeLessThanOrEqual(view.bottom + 0.5)
    const last = [...scroller.querySelectorAll('[role="option"]')].at(-1)!.getBoundingClientRect()
    expect(row.top, '「配置模型」没排在最后一个模型下面').toBeGreaterThanOrEqual(last.bottom)
  })
})

it.each([
  { id: 'codex', name: 'Codex', invalid: '7k', range: '8k–199999' },
  { id: 'claude', name: 'Claude Code', invalid: '64k', range: '100k–199999' },
])('uses the $name minimum and changes the threshold without changing context usage', async ({ id, name, invalid, range }) => {
  const mount = document.createElement('div')
  mount.style.cssText = 'position:fixed;right:24px;bottom:24px;width:640px'
  document.body.appendChild(mount)
  const composer = createRoot(mount)
  function Fixture() {
    const [value, setValue] = useState<number | null>(150_000)
    return (
      <SessionLocalizationProvider>
        <ChatComposer modelOptions={MODELS} selectedModel="platform:glm-5.3-flash"
          agentOptions={[{ id, name }]} selectedAgent={id} agentLocked
          onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}}
          contextUsage={{ used: 40_000, size: 200_000, costSource: 'platform' }}
          contextThresholds={(_id, maximum) => maximum ? {
            minimum: contextThresholdMinimum(id), maximum, value, set: async (next) => setValue(next),
          } : undefined} />
      </SessionLocalizationProvider>
    )
  }
  try {
    composer.render(<Fixture />)
    const ring = page.getByRole('button', { name: new RegExp(`${name}.*Context window`) })
    await ring.click()
    await expect.element(page.getByText('Context usage', { exact: true })).toBeVisible()
    await expect.element(page.getByText('20.0%', { exact: true })).toBeVisible()
    const footer = page.getByRole('button', { name: /Auto.?compact/i })
    await expect.element(footer).toHaveTextContent('150K')
    await footer.click()
    const input = page.getByRole('textbox', { name: 'Enter a custom threshold', exact: true })
    await input.fill(invalid)
    await userEvent.keyboard('{Enter}')
    await expect.element(input).toHaveAttribute('aria-invalid', 'true')
    await expect.element(page.getByRole('alert')).toHaveTextContent(`Enter ${range} tokens.`)
    await expect.element(page.getByText('20.0%', { exact: true })).toBeVisible()
    await input.fill('100k')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByText('20.0%', { exact: true })).toBeVisible()
    await expect.element(footer).toHaveTextContent('100K')
    await footer.click()
    await expect.element(page.getByRole('button', { name: '100K', exact: true })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    composer.unmount()
    mount.remove()
  }
})
