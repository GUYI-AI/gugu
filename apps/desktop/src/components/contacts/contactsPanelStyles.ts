// 通讯录(ContactsPanel)和它拆出去的详情页(ContactDetail)共用的样式与小函数:原样从 ContactsPanel.tsx 搬出(那个文件行数冻结、只减不增)。
import type { KeyboardEvent } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { agentContactAvatarBadgeClass, type AgentContactTone } from '../contactAgentTone'
import { formatDate, i18n } from '../../i18n'
import { cn } from '@/lib/cn'

export const ct = i18n.getFixedT(null, 'contacts')

// @@@ui-ruler 本地样式副本(rowBase / meta / name / sharedTag / reqBadge / section* / cpane*)已按角色
// 收口进原语,这里只剩原语不管的那点:头像壳(agent 状态角标挂在它的 ::after 上)、
// 详情面排版。几何一律取 tokens,❌ 字面量像素。
// 名字(人 / Agent / 群)在资料卡与详情标题里最多两行,再长省略号,悬停 title 看全名;页头与列表行是一行(.gg-pane-title / .gg-list-row-title)。
export const nameClampClass = 'line-clamp-2 [overflow-wrap:anywhere]'
export const rowAvatarClass =
  'gg-c-av flex h-[var(--avatar-sm)] w-[var(--avatar-sm)] shrink-0 items-center justify-center overflow-hidden rounded-full'
// 行内改名/备注输入:控件高与 Button/Field 同一把尺子(--control-h-md)。
export const inlineInputClass =
  'h-[var(--control-h-md)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)] !px-2 text-sm text-[var(--fg)] outline-none'
// 详情面里的说明/分节标题(内容读文,--font-body)。
export const detailCaptionClass = 'text-[length:var(--font-body)] text-[var(--muted-fg)]'
export const detailBlockClass = '!mt-6 max-w-[620px]'
// 详情面里的一行提示条(加载中/为空/出错):控件高一档,圆角与卡片同 --r。
export const detailNoticeClass =
  'flex min-h-[var(--control-h-lg)] items-center rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)] !px-3 text-[length:var(--font-body)] text-[var(--muted-fg)]'
// 详情面里的卡片行(公开 Agent / 群成员):同一内距、同一圆角、同一边框。
export const detailCardRowClass =
  'flex min-h-[var(--control-h-touch)] min-w-0 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)] !p-2'
// 详情面里的标题(群名 / Agent 名)。
export const detailTitleTypeClass = 'text-lg font-semibold text-[var(--fg)]'
export const detailTitleClass = `${detailTitleTypeClass} ${nameClampClass}`
export const detailPlaceholderClass = 'flex flex-1 items-center justify-center text-sm text-[var(--muted-fg)]'
export const detailSectionClass = (mobile?: boolean) => (mobile ? '!px-4 !py-5' : '!px-6 !py-6')
export const detailBodyClass = (mobile?: boolean) =>
  cn(
    'flex-1 overflow-y-auto overflow-x-hidden',
    mobile ? '!px-4 !pt-4 !pb-[max(24px,env(safe-area-inset-bottom))]' : '!px-6 !py-6',
  )

export const agentAvatarClass = (tone: AgentContactTone | null) => cn(rowAvatarClass, agentContactAvatarBadgeClass(tone))

/** ListRow 的根是 div(行里要嵌删除钮,按钮不能嵌按钮),键盘可达性靠 role/tabIndex + Enter/Space 补齐。 */
export const rowKeyActivate = (activate: () => void) => (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}

export function formatDateTime(value?: string | null): string {
  if (!value) return ct('common.unknown')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ct('common.unknown')
  return formatDate(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function getAgentProjectPath(contact: ContactUser): string | null {
  if (contact.project_path) return contact.project_path
  const match = contact.bio?.match(/项目目录：\s*([^·]+)/)
  return match?.[1]?.trim() || null
}

// @@@1514 channel 概念已抹除(并入 group)：agent 分享会话即普通 group。
// @@@1787 分组措辞统一用「群组」(桌面三段 sidebar: Agent/个人/群组)。
export function groupChatListTitle(): string {
  return ct('panel.groupSectionTitle')
}

export function groupChatListCountLabel(count: number): string {
  return ct('panel.groupCount', { count })
}

export function groupChatSummaryLabel(count: number): string {
  return ct('panel.groupCountSummary', { count })
}
