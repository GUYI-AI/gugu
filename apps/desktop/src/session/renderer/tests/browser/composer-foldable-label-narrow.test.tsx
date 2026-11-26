import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
import { icon as codexIcon } from '../../../../../../../packages/session-plugins/src/agents/impl/codex/icon'
// 主题层与同目录 composer-narrow-pane-7052 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@renderer/lib/stores/use-agents', async (original) => ({
  ...(await original<object>()),
  useAgentIcon: (id: string) => (id === 'codex' ? codexIcon : null),
}))

const { composerVerbLook } = await import('@renderer/features/sessions/composer-verb-tag')

/** Verify the session toolbar and the task draft tag stay readable in narrow panes. */

const MODELS = () =>
  composerModelOptions(
    { 'gpt-5.6-sol': { name: 'GPT-5.6 Sol', description: '400K 上下文' } },
    [
      {
        id: 'deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        protocol: 'openai-chat-completions',
        creditMultiplier: 0.5,
        contextWindow: 1_000_000,
        reasoningEfforts: null,
      },
    ],
    { ownTierLabel: '你的 Codex 模型', icon: modelProviderIcon }
  )

let root: Root | null = null
let container: HTMLDivElement | null = null
let previousLanguage = 'zh-CN'

beforeEach(async () => {
  previousLanguage = i18n.language
  await i18n.changeLanguage('zh-CN')
  await page.viewport(1200, 700)
  document.body.style.margin = '0'
  container = document.createElement('div')
  container.className = 'gugu-skin'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
  await i18n.changeLanguage(previousLanguage)
})

const TOOLBAR = '[data-slot="composer-toolbar"]'
const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))
const shown = (el: Element | null) => !!el && el.getBoundingClientRect().width > 0

async function renderComposer(width: number, { tag }: { tag: boolean }) {
  container!.style.width = `${width}px`
  const models = MODELS()
  const platformId = Object.keys(models ?? {}).find((id) => id.startsWith('platform:'))!
  root!.render(
    <SessionLocalizationProvider>
      <ChatComposer
        modelOptions={models}
        selectedModel={platformId}
        onModelChange={() => {}}
        agentOptions={[{ id: 'codex', name: 'Codex', icon: <svg width="14" height="14" /> }]}
        selectedAgent="codex"
        // 会话里 agent 已经定了(锁着,档 5 让位);新建智能体的框里还能选。
        agentLocked={!tag}
        permissionModeOptions={{ full: { name: '完全访问', destructive: true } }}
        selectedPermissionMode="full"
        leading={tag ? composerVerbLook('task', { label: '新建智能体', onCancel: () => {}, testId: 'tag' }).tag('codex') : undefined}
        onAttach={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>
  )
  await until('底排画出来', () => document.querySelector(`${TOOLBAR} button[aria-label="发送消息"]`) !== null)
  // 阶梯逐档爬,每档一次重排;等它停下(连续几帧档位不变)。
  let last: string | null = null
  for (let same = 0, frames = 0; same < 3 && frames < 120; frames++) {
    await settle()
    const now = document.querySelector(TOOLBAR)?.getAttribute('data-disclosure') ?? null
    same = now !== null && now === last ? same + 1 : 0
    last = now
  }
}

describe('session composer in a narrow pane', () => {
  it('narrowed in one step (a fold landing), the row folds before that frame paints: no labels over each other', async () => {
    await renderComposer(640, { tag: false })
    expect(document.querySelector(TOOLBAR)!.getAttribute('data-disclosure')).toBe('0')
    // Observers run in creation order, after the composer's own and before paint: what this one sees is what gets painted.
    const painted = await new Promise<{ level: string | null; overlaps: number }>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect()
        const visible = [...document.querySelectorAll<HTMLElement>(`${TOOLBAR} button`)]
          .map((el) => el.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0)
          .sort((a, b) => a.left - b.left)
        const bar = document.querySelector(TOOLBAR)!.getBoundingClientRect()
        let overlaps = visible.at(-1)!.right > bar.right + 0.5 ? 1 : 0
        for (let i = 1; i < visible.length; i++) if (visible[i].left < visible[i - 1].right - 1) overlaps++
        resolve({ level: document.querySelector(TOOLBAR)!.getAttribute('data-disclosure'), overlaps })
      })
      requestAnimationFrame(() => {
        container!.style.width = '213px'
        observer.observe(document.querySelector(TOOLBAR)!)
      })
    })
    expect(painted.overlaps, `buttons over each other in the painted frame (level ${painted.level})`).toBe(0)
  })

  it('会话底排宽:锁着的 harness 标在模型左边、不灰,模型那格不再画厂商图形', async () => {
    await renderComposer(640, { tag: false })
    const harness = document.querySelector<HTMLElement>(`${TOOLBAR} button[disabled][aria-label]:has(svg)`)!
    expect(shown(harness), 'harness 标在').toBe(true)
    expect(getComputedStyle(harness).opacity).toBe('1')
    const model = document.querySelector('[data-testid="composer-model-trigger"]')!
    expect(harness.getBoundingClientRect().right).toBeLessThanOrEqual(model.getBoundingClientRect().left)
    expect(shown(model.querySelector('[role="img"]')), '厂商图形收掉').toBe(false)
  })

  it('会话底排 213px:harness 标让位,模型只剩厂商图形', async () => {
    await renderComposer(213, { tag: false })
    const model = document.querySelector('[data-testid="composer-model-trigger"]')!
    expect(shown(model.querySelector('[role="img"]')), '厂商图形回来').toBe(true)
    expect(shown(document.querySelector(`${TOOLBAR} button[disabled][aria-label]:has(svg)`))).toBe(false)
  })

  it('输入行最前那枚「新建智能体 ×」在窄框里只剩标和 ×,编辑区不被挤没', async () => {
    await renderComposer(192, { tag: true })
    const tag = document.querySelector('[data-testid="tag-verb"]')!
    expect(tag.getAttribute('title')).toBe('新建智能体')
    expect(shown(tag.querySelector('[data-slot="composer-foldable-label"]'))).toBe(false)
    expect(shown(document.querySelector('[data-testid="tag-cancel"]'))).toBe(true)
    // 父版实测编辑区只剩 30px,placeholder 一行两个字。
    const editor = document.querySelector('[data-testid="prompt-editor"]')!.getBoundingClientRect()
    expect(editor.width).toBeGreaterThan(80)
  })

  it('框宽时那枚标签照旧写着字', async () => {
    await renderComposer(640, { tag: true })
    expect(shown(document.querySelector('[data-testid="tag-verb"] [data-slot="composer-foldable-label"]'))).toBe(true)
  })
})
