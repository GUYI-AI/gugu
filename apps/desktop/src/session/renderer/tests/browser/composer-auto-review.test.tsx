import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { withAutoReviewHint } from '@renderer/features/sessions/acp/auto-review-permission-hint'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { UI_EVENTS } from '@/lib/uiEvents'
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
  await until('review detail', () => document.querySelector('[data-slot="permission-mode-detail"]')?.textContent?.includes('消耗咕咕积分') === true)
  const detail = document.querySelector<HTMLElement>('[data-slot="permission-mode-detail"]')!
  expect(detail.textContent).toContain('需要授权时交给 AI 审查')
  expect(detail.getBoundingClientRect().left).toBeGreaterThanOrEqual(menu.getBoundingClientRect().right)
  await page.getByRole('option', { name: '编辑', exact: true }).hover()
  await until('editing detail replaces reviewer', () => document.querySelector('[data-slot="permission-mode-detail"]')?.textContent === '编辑说明')
  await page.getByRole('option', { name: '自动模式', exact: true }).click()
  expect(changed.mock.calls).toEqual([['ai-review']])
})

it.each([
  ['claude', 'subscription', '使用你的 Claude 订阅额度'],
  ['codex', 'subscription', '使用你的 ChatGPT 订阅额度'],
  ['claude', 'api-key', '使用你的 API Key'],
  ['claude', 'platform', '由 Claude Haiku 5.5 审查，消耗咕咕积分'],
] as const)('labels the actual %s %s payer', (provider, source, label) => {
  expect(withAutoReviewHint({ auto: { name: '自动模式' } }, provider, source, { 'ai-review': { id: 'auto' } })?.auto?.detail).toBe(label)
})

it('keeps an unavailable Auto row visible, explains it on hover and never emits selection', async () => {
  const options = withAutoReviewHint({ edit: { name: '编辑' }, 'ai-review': { name: '自动模式', disabled: true } }, 'claude', 'api-key');
  root.render(<SessionLocalizationProvider><ChatComposer permissionModeOptions={options} selectedPermissionMode="edit"
    onPermissionModeChange={changed} onSubmit={() => {}} onStop={() => {}} /></SessionLocalizationProvider>);
  await until('permission trigger', () => container.querySelector('[data-slot="composer-permission-mode"]') != null);
  await page.getByText('编辑', { exact: true }).click();
  await until('permission menu mounted', () => document.querySelector('[data-slot="combobox-content"]') != null);
  const row = page.getByRole('option', { name: '自动模式', exact: true });
  await expect.element(row).toHaveAttribute('aria-disabled', 'true');
  await row.hover();
  await until('unavailable reason shown', () => document.querySelector('[data-slot="permission-mode-detail"]')?.textContent === '此连接没有可用于审查的模型');
  row.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(changed).not.toHaveBeenCalled();
});

it('names the reviewer the host resolved and who pays for it', () => {
  const hint = (kind: 'platform' | 'connection') => withAutoReviewHint({ auto: { name: '自动模式', reviewer: { label: 'Claude Sonnet 4.6', kind } } },
    'claude', 'platform', { 'ai-review': { id: 'auto' } })?.auto?.detail
  expect(hint('platform')).toBe('由 Claude Sonnet 4.6 审查，消耗咕咕积分')
  expect(hint('connection')).toBe('由 Claude Sonnet 4.6 审查，使用你的 API Key')
})

it('sends a greyed Auto mode with no reviewer to the review model setting', async () => {
  const opened = vi.fn()
  const open = (event: Event) => opened((event as CustomEvent).detail)
  window.addEventListener(UI_EVENTS.openSettings, open)
  try {
    const options = withAutoReviewHint({ edit: { name: '编辑' },
      'ai-review': { name: '自动模式', disabled: true, description: translateSessionMessage('taskConfig.reviewNoReviewer') } }, 'claude', 'platform')
    root.render(<SessionLocalizationProvider><ChatComposer permissionModeOptions={options} selectedPermissionMode="edit"
      onPermissionModeChange={changed} onSubmit={() => {}} onStop={() => {}} /></SessionLocalizationProvider>)
    await until('permission trigger', () => container.querySelector('[data-slot="composer-permission-mode"]') != null)
    await page.getByText('编辑', { exact: true }).click()
    await until('permission menu mounted', () => document.querySelector('[data-slot="combobox-content"]') != null)
    await page.getByRole('option', { name: '自动模式', exact: true }).hover()
    await until('reason and link shown', () => document.querySelector('[data-slot="permission-mode-detail"]')?.textContent?.includes('去设置里选一个审查模型') === true)
    await page.getByTestId('auto-review-choose-model').click()
    expect(opened.mock.calls).toEqual([[{ section: 'model', action: 'review-model' }]])
    expect(changed).not.toHaveBeenCalled()
  } finally { window.removeEventListener(UI_EVENTS.openSettings, open) }
})

it('offers no settings link where no reviewer choice would turn Auto mode on', () => {
  const detail = (reason: Parameters<typeof translateSessionMessage>[0]) => withAutoReviewHint({
    auto: { name: '自动模式', disabled: true, description: translateSessionMessage(reason) } }, 'claude', 'platform', { 'ai-review': { id: 'auto' } })?.auto?.detail
  expect(detail('taskConfig.reviewMainModelUnsupported')).toBeUndefined()
  expect(detail('taskConfig.reviewCrossReviewerUnroutable')).toBeUndefined()
  expect(detail('taskConfig.reviewVersionUnsupported')).toBeUndefined()
  // The ticket lacks the reviewer: choosing it again in Settings would not turn Auto mode on.
  expect(detail('taskConfig.reviewReviewerNotOnTicket')).toBeUndefined()
  expect(detail('taskConfig.reviewPreferenceUnavailable')).toBeDefined()
})
