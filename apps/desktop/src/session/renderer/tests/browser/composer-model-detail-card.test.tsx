import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { enUSMessages } from '@renderer/localization/messages'
// 主题层与同目录 composer-disabled-options 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * #7056 owner 2026-10-10 看着 Cursor 的模型下拉提的三件事,这里钉住面板上的两件:
 *  ① 单行清单 + 悬浮详情卡 —— 行里只有名字,说明 / 倍率 / 上下文 / 推理档在悬停出来的卡里;
 *  ③ 底部「升级解锁更多模型」—— 用不了的模型不进清单,悬停这一条看得到是哪几个,点它走宿主的升级去路。
 * 还有「管理模型」:点了收起面板、交给宿主开设置里的「模型」页(② 的入口)。
 *
 * 同日看实机后又提的三处也钉在这里:行尾不再写倍率、厂商过滤片一样大、「思考」那一段收紧。
 */
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
    description: '相对倍率 ×0.04',
    facts: [{ label: '思考', value: '低 · 高' }],
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
const onModelUpgrade = vi.fn()
const onModelChange = vi.fn()

const panel = () => document.querySelector<HTMLElement>('[data-slot="combobox-content"]')
const detail = () => document.querySelector<HTMLElement>('[data-slot="composer-model-detail"]')
const rowByName = (name: string): HTMLElement =>
  ([...(panel()?.querySelectorAll('[data-slot="composer-model-name"]') ?? [])]
    .find((el) => el.textContent?.trim() === name)
    ?.closest('[role="option"]') as HTMLElement)

describe('模型面板:单行清单 · 悬浮详情卡 · 底部去路', () => {
  beforeEach(async () => {
    await page.viewport(1400, 800)
    onManageModels.mockReset()
    onModelUpgrade.mockReset()
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
          onManageModels={onManageModels}
          modelUpgrade={{ label: '升级解锁更多模型', title: '开通会员后可用', models: ['Claude Opus 5', 'GPT-5.6 Sol'] }}
          onModelUpgrade={onModelUpgrade}
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

  it('draws one line per model: just the name — no rate, no description line', () => {
    const row = rowByName('GLM 5.3 Flash')
    // owner 2026-10-10:「卡片里已经展示过了,右侧就不要再展示相对倍率了」。
    expect(row.textContent).not.toContain('×0.04')
    expect(row.textContent).not.toContain('相对倍率')
    expect(rowByName('Opus 5.5').textContent).not.toContain('Best for everyday tasks')
  })

  it('gives every provider filter the same size, four to a row, without cutting off the long names', () => {
    // owner 2026-10-10:「按钮块的大小能保持一致,有时候智谱那块太小了,不好点」。
    const chips = [...panel()!.querySelectorAll<HTMLElement>('[data-testid^="composer-model-provider-"]')]
    expect(chips.map((c) => c.textContent)).toEqual(['Anthropic', '智谱', 'DeepSeek', 'Google'])
    const boxes = chips.map((c) => c.getBoundingClientRect())
    for (const box of boxes) {
      expect(Math.abs(box.width - boxes[0].width), '过滤片宽度不一').toBeLessThan(0.5)
      expect(Math.abs(box.top - boxes[0].top), '四家没排在同一行').toBeLessThan(0.5)
    }
    for (const chip of chips) {
      expect(chip.scrollWidth, `${chip.textContent} 被截断了`).toBeLessThanOrEqual(chip.clientWidth)
    }
    // 各自分开,❌ 连成一条(owner 同日:「不同厂家怎么连在一块了」)。
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].left - boxes[i - 1].right, '相邻两块之间没有缝').toBeGreaterThanOrEqual(2)
    }
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

  it('shows a detail card for the hovered model: who it belongs to, what it is, context and thinking levels', async () => {
    await page.elementLocator(rowByName('GLM 5.3 Flash')).hover()
    await until('detail card opens on hover', () => detail()?.textContent?.includes('GLM 5.3 Flash') === true)
    const text = detail()!.textContent!
    expect(text).toContain('咕咕模型按积分计费')
    expect(text).toContain('相对倍率 ×0.04')
    expect(text).toContain('200K tokens')
    expect(text).toContain('低 · 高')
    // 卡开着,面板还在:鼠标移向卡不能把清单关掉。
    expect(panel()).not.toBeNull()

    await page.elementLocator(rowByName('Opus 5.5')).hover()
    await until('detail card follows the pointer', () => detail()?.textContent?.includes('Opus 5.5') === true)
    expect(detail()!.textContent).toContain('Best for everyday tasks')
    expect(detail()!.textContent).toContain('1M tokens')
  })

  it('lists what an upgrade unlocks on hover and hands the click to the host', async () => {
    const upgrade = document.querySelector<HTMLElement>('[data-testid="composer-model-upgrade"]')!
    expect(upgrade.textContent).toBe('升级解锁更多模型')
    await page.elementLocator(upgrade).hover()
    await until('upgrade card opens', () => detail()?.textContent?.includes('开通会员后可用') === true)
    // 一行一个,好扫。
    expect([...detail()!.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Claude Opus 5', 'GPT-5.6 Sol'])
    upgrade.click()
    expect(onModelUpgrade).toHaveBeenCalledTimes(1)
  })

  it('opens a disabled model’s reason on pointer hover and keeps the selection unchanged', async () => {
    const row = rowByName('DeepSeek V4 Flash')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    await page.elementLocator(row).hover()
    await until('disabled model detail card opens', () => detail()?.textContent?.includes('This provider does not support the required API') === true)
    row.click()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('closes the panel and hands off to settings from 「管理模型」', async () => {
    document.querySelector<HTMLElement>('[data-testid="composer-model-manage"]')!.click()
    expect(onManageModels).toHaveBeenCalledTimes(1)
    await until('panel closes', () => panel() === null)
  })
})

describe('#7123 英文界面:底部「Upgrade to unlock more models」整句都在面板里', () => {
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
          modelUpgrade={{ label: en('composer.platformModelUpgrade'), title: en('composer.platformModelUpgradeTitle'), models: ['Claude Opus 5'] }}
          onModelUpgrade={() => {}}
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
    const upgrade = document.querySelector<HTMLElement>('[data-testid="composer-model-upgrade"]')!
    expect(upgrade.textContent).toBe('Upgrade to unlock more models')
    const box = upgrade.getBoundingClientRect()
    // 判的是底栏的内容区(面板右缘减去底栏右内边距),❌ 只看面板:测试里字体比实机窄,旧写法也只伸进内边距、还没出面板;
    // 实机上同一份溢出就到了面板外被裁掉(#7123,约 19px)。
    const footer = document.querySelector<HTMLElement>('[data-slot="composer-model-footer"]')!
    const contentRight = footer.getBoundingClientRect().right - parseFloat(getComputedStyle(footer).paddingRight)
    expect(box.right, '按钮伸出了底栏的内容区').toBeLessThanOrEqual(contentRight + 0.5)
    expect(upgrade.scrollWidth, '字在按钮里被截断了').toBeLessThanOrEqual(upgrade.clientWidth)
  })
})

it('uses a single editable context threshold in the ring and the model detail', async () => {
  const mount = document.createElement('div')
  mount.style.cssText = 'position:fixed;right:24px;bottom:24px;width:640px'
  document.body.appendChild(mount)
  const composer = createRoot(mount)
  function Fixture() {
    const [value, setValue] = useState<number | null>(null)
    return (
      <SessionLocalizationProvider>
        <ChatComposer modelOptions={MODELS} selectedModel="platform:glm-5.3-flash"
          agentOptions={[{ id: 'codex', name: 'Codex' }]} selectedAgent="codex" agentLocked
          onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}}
          contextUsage={{ used: 40_000, size: 200_000, costSource: 'platform' }}
          contextThresholds={(_id, maximum) => maximum ? { maximum, value, set: async (next) => setValue(next) } : undefined} />
      </SessionLocalizationProvider>
    )
  }
  try {
    composer.render(<Fixture />)
    await page.getByRole('button', { name: /Codex.*Context window/ }).click()
    await expect.element(page.getByText('Context usage', { exact: true })).toBeVisible()
    await expect.element(page.getByText('20.0%', { exact: true })).toBeVisible()
    const footer = page.getByRole('button', { name: /200.* context/ })
    await expect.element(footer).not.toHaveTextContent('Default')
    await footer.click()
    const input = page.getByRole('textbox', { name: 'Context window', exact: true })
    await input.fill('100k')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByText('40.0%', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Codex.*Context window/ }).click()
    await page.getByTestId('composer-model-trigger').click()
    await page.elementLocator(rowByName('GLM 5.3 Flash')).hover()
    const threshold = page.getByRole('button', { name: /Context window.*100K/ })
    await expect.element(threshold).toBeVisible()
    await threshold.hover()
    await expect.element(page.getByRole('textbox', { name: 'Context window', exact: true })).toBeVisible()
  } finally {
    composer.unmount()
    mount.remove()
  }
})
