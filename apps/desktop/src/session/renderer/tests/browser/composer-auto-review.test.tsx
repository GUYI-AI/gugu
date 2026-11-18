import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { withAutoReviewHint } from '@renderer/features/sessions/acp/auto-review-permission-hint'
import { i18n } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root, container: HTMLDivElement, language: string
const changed = vi.fn()
beforeEach(async () => {
  language = i18n.language
  await i18n.changeLanguage('zh-CN')
  await page.viewport(1100, 800)
  changed.mockClear()
  container = document.createElement('div')
  container.style.cssText = 'width:650px;position:absolute;left:100px;bottom:30px'
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { root.unmount(); container.remove(); await i18n.changeLanguage(language) })

it('shows names in the menu, details to its right, and a shield in selected Auto mode', async () => {
  const options = withAutoReviewHint({
    plan: { name: '规划', description: '规划说明' },
    'read-only': { name: '只读', description: '只读说明' },
    edit: { name: '编辑', description: '编辑说明' },
    'ai-review': { name: '自动模式', description: '需要授权时交给 AI 审查，连续被拒会停下来找你。' },
    'full-access': { name: '完全访问', description: '完全访问说明', destructive: true },
  }, 'claude', 'platform')
  root.render(<SessionLocalizationProvider><ChatComposer permissionModeOptions={options}
    selectedPermissionMode="ai-review" onPermissionModeChange={changed} onSubmit={() => {}} onStop={() => {}} /></SessionLocalizationProvider>)
  await until('permission trigger', () => container.querySelector('[data-slot="composer-permission-mode"]') != null)
  const trigger = container.querySelector<HTMLElement>('[data-slot="composer-permission-mode"]')!
  expect(trigger.textContent).toBe('自动模式')
  expect(getComputedStyle(trigger.querySelector('svg')!.parentElement!).display).not.toBe('none')
  await page.getByText('自动模式', { exact: true }).click()
  await until('permission menu mounted', () => document.querySelector('[data-slot="combobox-content"]') != null)
  const menu = document.querySelector<HTMLElement>('[data-slot="combobox-content"]')!
  expect(menu.textContent).not.toContain('需要授权')
  expect(menu.textContent).not.toContain('编辑说明')
  await page.getByRole('option', { name: '自动模式', exact: true }).hover()
  await until('review detail', () => document.querySelector('[data-slot="permission-mode-detail"]')?.textContent?.includes('扣咕咕积分') === true)
  const detail = document.querySelector<HTMLElement>('[data-slot="permission-mode-detail"]')!
  expect(detail.textContent).toContain('需要授权时交给 AI 审查')
  expect(detail.getBoundingClientRect().left).toBeGreaterThanOrEqual(menu.getBoundingClientRect().right)
  await page.getByRole('option', { name: '编辑', exact: true }).hover()
  await until('editing detail replaces reviewer', () => document.querySelector('[data-slot="permission-mode-detail"]')?.textContent === '编辑说明')
  await page.getByRole('option', { name: '自动模式', exact: true }).click()
  expect(changed.mock.calls).toEqual([['ai-review']])
})

it.each([
  ['claude', 'subscription', '用你的 Claude 订阅额度审'],
  ['codex', 'subscription', '用你的 ChatGPT 订阅额度审'],
  ['claude', 'api-key', '用你的 API Key 审'],
  ['claude', 'platform', '用 Claude Haiku 5.5 审，扣咕咕积分'],
] as const)('labels the actual %s %s payer', (provider, source, label) => {
  expect(withAutoReviewHint({ auto: { name: '自动模式' } }, provider, source, { 'ai-review': { id: 'auto' } })?.auto?.detail).toBe(label)
})
