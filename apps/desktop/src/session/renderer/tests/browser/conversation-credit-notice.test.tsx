import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { i18n } from '@/i18n'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import type { TranscriptTurn } from '@gugu/session-chat-ui'
import '@/i18n/registerSettingsCatalog'
import { publishSelfIdentity } from '@/lib/selfIdentityBridge'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

const fixture = vi.hoisted(() => ({ spendable: 0.999 }))
const theme = import.meta.env.VITE_CREDIT_THEME === 'dark' ? 'dark' : 'light'
vi.mock('@/lib/billing', async original => ({ ...(await original<object>()), useSpendingPower: () => ({ power: { spendable: fixture.spendable } }) }))
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); publishSelfIdentity(null); document.documentElement.removeAttribute('data-theme') })

it.each([360, 390, 800])('keeps the quiet credit line above the real conversation composer at %spx', async width => {
  await page.viewport(width, 720)
  await i18n.changeLanguage('zh-CN')
  document.documentElement.setAttribute('data-theme', theme)
  fixture.spendable = 0.999
  publishSelfIdentity({ userId: 'credit-fixture', displayName: null, guguNumber: null })
  harness = createReactHarness()
  harness.container.style.cssText = `width:${width - 24}px;padding:12px;display:flex;flex-direction:column;box-sizing:content-box;background:var(--bg)`
  await renderWithAppProviders(harness, <ThemeProvider theme={theme}><SessionLocalizationProvider>
    <AgentConversationComposer mobile={width < 720} selectedModel="platform:test" modelOptions={{ 'platform:test': { name: '咕咕模型' } }} onSubmit={() => {}} />
  </SessionLocalizationProvider></ThemeProvider>)
  await until('real conversation composer and credit line mount', () => !!harness.container.querySelector('[data-slot="composer"]') && !!harness.container.querySelector('[data-testid="conversation-credit-notice"]'))
  const notice = harness.container.querySelector<HTMLElement>('[data-testid="conversation-credit-notice"]')!
  const composer = harness.container.querySelector<HTMLElement>('[data-slot="composer"]')!
  expect(notice.textContent).toBe('剩 1 积分 充值')
  expect(notice.getBoundingClientRect().bottom).toBeLessThanOrEqual(composer.getBoundingClientRect().top)
  expect(notice.scrollWidth).toBeLessThanOrEqual(width - 24)
  expect(notice.querySelector('svg, [aria-label]')).toBeNull()
  expect(getComputedStyle(notice).position).toBe('static')
  if (import.meta.env.VITE_CREDIT_CAPTURE === '1') await page.screenshot({ element: harness.container, path: `__screenshots__/credit-composer-${theme}-${width}.png` })
})

it.each([360, 800])('renders the real interrupted turn once as ordinary body text at %spx', async width => {
  await page.viewport(width, 720)
  await i18n.changeLanguage('zh-CN')
  document.documentElement.setAttribute('data-theme', theme)
  fixture.spendable = 0
  publishSelfIdentity({ userId: 'credit-fixture', displayName: null, guguNumber: null })
  const said = '咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。'
  const turns: TranscriptTurn[] = [{ id: 'credit-turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'credit-prompt', seq: 0, role: 'user', text: '继续刚才的对话' },
  ], outcome: { kind: 'error', reason: 'prompt_failed', said, detail: `{"error":{"message":"${said}","code":"credits_exhausted"}}` } }]
  harness = createReactHarness()
  harness.container.style.cssText = `height:500px;width:${width - 24}px;padding:12px;display:flex;flex-direction:column;box-sizing:content-box;background:var(--bg)`
  await renderWithAppProviders(harness, <ThemeProvider theme={theme}><SessionLocalizationProvider>
    <SessionTranscriptView uri={`credit-fixture-${width}`} turns={turns} mobile={width < 720}
      composerContent={<AgentConversationComposer mobile={width < 720} selectedModel="platform:test" onSubmit={() => {}} />} />
  </SessionLocalizationProvider></ThemeProvider>)
  await until('the interrupted turn and real composer have mounted', () => !!harness.container.querySelector('[data-credit-exhausted]') && !!harness.container.querySelector('[data-slot="composer"]'))
  expect(harness.container.querySelectorAll('[data-credit-exhausted]')).toHaveLength(1)
  const exhausted = harness.container.querySelector<HTMLElement>('[data-credit-exhausted]')!
  expect(exhausted.textContent?.replace(/\n/g, '')).toBe('积分用完了，充值后继续')
  expect(exhausted.textContent?.match(/充值/g)).toHaveLength(1)
  expect(exhausted.querySelectorAll('a')).toHaveLength(1)
  expect(exhausted.querySelector('a')?.textContent?.trim()).toBe('充值')
  expect(harness.container.querySelector('[data-testid="conversation-credit-notice"]')).toBeNull()
  expect(harness.container.querySelector('[data-credit-exhausted] [role="alert"], [data-credit-exhausted] [data-slot="turn-outcome-badge"]')).toBeNull()
  expect(harness.container.querySelector('[data-slot="credit-recharge"]')).not.toBeNull()
  if (import.meta.env.VITE_CREDIT_CAPTURE === '1') await page.screenshot({ element: harness.container, path: `__screenshots__/credit-exhausted-${theme}-${width}.png` })
})

it.each([
  { reason: 'team_member_monthly_cap_reached', text: '你本月的团队积分用完了，只影响你，其他人照常用。找管理员调高上限。' },
  { reason: 'team_credits_exhausted', text: '团队积分用完了，所有成员暂时无法使用 AI。找管理员充值。' },
])('keeps the typed team refusal $reason in the real conversation without a personal wallet link', async ({ reason, text }) => {
  await page.viewport(1440, 960)
  await i18n.changeLanguage('zh-CN')
  publishSelfIdentity({ userId: 'team-credit-fixture', displayName: '林晓', guguNumber: null, accountKind: 'team_member' })
  const turns: TranscriptTurn[] = [{ id: 'team-credit-turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'team-credit-prompt', seq: 0, role: 'user', text: '继续' },
  ], outcome: { kind: 'error', reason: 'prompt_failed', detail: JSON.stringify({ error: { code: 'credits_exhausted', reason_code: reason, message: 'private server diagnostics' } }) } }]
  harness = createReactHarness()
  harness.container.style.cssText = 'height:700px;width:960px;padding:24px;display:flex;flex-direction:column;box-sizing:content-box;background:var(--bg)'
  await renderWithAppProviders(harness, <ThemeProvider theme="light"><SessionLocalizationProvider>
    <SessionTranscriptView uri={`team-credit-${reason}`} turns={turns}
      composerContent={<AgentConversationComposer selectedModel="platform:test" onSubmit={() => {}} />} />
  </SessionLocalizationProvider></ThemeProvider>)
  await until('the shared team error row and composer mount', () => !!harness.container.querySelector('[data-credit-exhausted]') && !!harness.container.querySelector('[data-slot="composer"]'))
  const row = harness.container.querySelector<HTMLElement>('[data-credit-exhausted]')!
  const composer = harness.container.querySelector<HTMLElement>('[data-slot="composer"]')!
  expect(row.textContent?.replace(/\n/g, '')).toBe(text)
  expect(row.querySelector('a')).toBeNull()
  expect(harness.container.querySelector('[data-testid="conversation-credit-notice"]')).toBeNull()
  expect(harness.container.textContent).not.toMatch(/private server diagnostics|·/)
  expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(composer.getBoundingClientRect().top - 8)
  expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight + 1)
  if (import.meta.env.VITE_TEAM_CAPTURE === '1') await page.screenshot({ element: harness.container, path: `__screenshots__/team-desktop-${reason}.png` })
})
