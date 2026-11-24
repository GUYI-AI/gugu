import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
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

  it('shows the thinking slider without a visible text row', () => {
    const row = panel()!.querySelector<HTMLElement>('[data-slot="composer-effort-row"]')!
    const slider = row.querySelector<HTMLInputElement>('input[type="range"]')!
    const value = row.querySelector<HTMLElement>('[data-slot="composer-effort-value"]')!
    expect(value.getClientRects()).toHaveLength(0)
    expect(slider.getAttribute('aria-valuetext')).toBe('高')
    expect(document.getElementById(slider.getAttribute('aria-describedby')!)?.textContent).toBe('想得更久,适合难题')
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

  it('opens a disabled model’s reason on pointer hover and keeps the selection unchanged', async () => {
    const row = rowByName('DeepSeek V4 Flash')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    await page.elementLocator(row).hover()
    await until('disabled model detail card opens', () => detail()?.textContent?.includes('This provider does not support the required API') === true)
    row.click()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('closes the panel and hands off to settings from 「管理模型」', async () => {
    const manage = document.querySelector<HTMLElement>('[data-testid="composer-model-manage"]')!
    expect(manage.hasAttribute('title')).toBe(false)
    expect(manage.parentElement?.querySelectorAll('button')).toHaveLength(1)
    manage.click()
    expect(onManageModels).toHaveBeenCalledTimes(1)
    await until('panel closes', () => panel() === null)
  })
})
