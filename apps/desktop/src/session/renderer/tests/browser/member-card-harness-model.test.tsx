/**
 * owner 11-25、11-26「我也看不出来他是什么智能体」:agent 的名片在状态与主人那行之下,用两枚浅底胶囊写出 harness
 * (带头像角标同款字形)与此刻的模型。两样都读在线态(主人、好友、同群的人都收得到);说不出的那一枚不画,模型说不出
 * 就只剩 harness。群里的资料卡与通讯录名片同一组;人的名片不变。真 Chromium、真 CSS、真组件。
 */
import type { ReactElement } from 'react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { contact, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import { i18n } from '@/i18n'
import '@/i18n/registerContactsCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

const { HARNESS, MODEL } = vi.hoisted(() => ({
  HARNESS: {} as Record<string, string>,
  MODEL: {} as Record<string, string | null>,
}))
vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/store/auth', async (original) => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'owner', bio: null, email: null } }) }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: (id: string | undefined) => (id && HARNESS[id]) ?? 'pending' }))
vi.mock('@/hooks/useAgentModelName', () => ({ useAgentModelName: (id: string | undefined) => (id && MODEL[id]) ?? null }))
const { MemberProfileCard } = await import('@/components/MemberProfileCard')
const { AgentContactProfileCard } = await import('@/components/contacts/ContactProfileCard')
let harness: ReturnType<typeof createReactHarness>
beforeAll(async () => { await i18n.changeLanguage('zh-CN') })
afterEach(() => harness?.cleanup())

const agent = (id: string, extra: Partial<MemberProfileCardModel> = {}) =>
  ({ id, displayName: '整理周报', avatar: null, type: 'agent', role: 'member', profileScope: 'group', membership: 'current', ownerUserId: 'owner', agentStatus: 'working', ...extra }) as MemberProfileCardModel
const texts = (selector: string) => [...harness.container.querySelectorAll(selector)].map((el) => el.textContent ?? '')
// 胶囊里的字;品牌字形是内联 svg,自带 <title>,❌ 读 chip 的整段 textContent。
const chips = () => texts('[data-agent-harness-model] > [data-slot="chip"] > .truncate')

async function render(node: ReactElement) {
  await page.viewport(1100, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  await renderWithAppProviders(harness, node)
}

it('my agent: harness and model are two filled capsules under the status / owner line, the harness with its glyph', async () => {
  HARNESS.mine = 'claude-code'
  MODEL.mine = 'Opus 5.5'
  await render(<MemberProfileCard member={agent('mine')} />)
  expect(texts('[data-profile-agent-meta] > span'), 'the status / owner line is unchanged').toEqual(['运行中', '我的智能体'])
  expect(chips()).toEqual(['Claude Code', 'Opus 5.5'])
  const harnessChip = harness.container.querySelector<HTMLElement>('[data-agent-harness-chip]')!
  expect(harnessChip.querySelector('[data-agent-harness="claude-code"]'), 'the same glyph as the avatar badge').not.toBeNull()
  for (const chip of harness.container.querySelectorAll<HTMLElement>('[data-agent-harness-model] > [data-slot="chip"]')) {
    expect(getComputedStyle(chip).backgroundColor, 'a filled capsule, not bare text').not.toBe('rgba(0, 0, 0, 0)')
    expect(chip.scrollWidth, 'nothing cut').toBeLessThanOrEqual(chip.clientWidth)
  }
  expect(harness.container.querySelector('[data-agent-harness-model]')!.textContent).not.toContain('·')
})

it("someone else's agent: the harness reaches them too; no model known ⇒ only the harness capsule", async () => {
  HARNESS.theirs = 'codex'
  await render(<MemberProfileCard member={agent('theirs', { ownerUserId: 'other', ownerDisplayName: '林夏', agentStatus: undefined })} />)
  expect(chips()).toEqual(['Codex'])
  expect(harness.container.querySelector('[data-agent-model-chip]')).toBeNull()
})

it('nothing known yet (presence still on its way) ⇒ no capsule row, ❌ a placeholder', async () => {
  await render(<MemberProfileCard member={agent('fresh')} />)
  expect(harness.container.querySelector('[data-agent-harness-model]')).toBeNull()
  expect(texts('[data-profile-agent-meta] > span')).toEqual(['运行中', '我的智能体'])
})

it("a person's card has no capsules", async () => {
  await render(<MemberProfileCard member={{ id: 'person', displayName: '林夏', avatar: null, email: null, type: 'human', role: 'member', profileScope: 'group' } as MemberProfileCardModel} />)
  expect(harness.container.querySelector('[data-agent-harness-model]')).toBeNull()
})

it('the contacts card shows the same two capsules', async () => {
  HARNESS.listed = 'antigravity'
  MODEL.listed = 'Gemini 3.5 Flash'
  await render(<AgentContactProfileCard contact={contact({ id: 'listed', display_name: '跑实验', type: 'agent', owner_user_id: 'owner' })} />)
  expect(chips()).toEqual(['Antigravity CLI', 'Gemini 3.5 Flash'])
})
