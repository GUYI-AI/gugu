// 通讯录(ContactsPanel)和它拆出去的详情页(ContactDetail)共用的样式与小函数:原样从 ContactsPanel.tsx 搬出(那个文件行数冻结、只减不增)。
import type { KeyboardEvent } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { formatDate, i18n } from '../../i18n'
import { cn } from '@/lib/cn'

export const ct = i18n.getFixedT(null, 'contacts')

// @@@ui-ruler 本地样式副本(rowBase / meta / name / sharedTag / reqBadge / section* / cpane*)已按角色
// 收口进原语,这里只剩原语不管的那点:头像壳(agent 状态角标挂在它的 ::after 上)、
// 详情面排版。几何一律取 tokens,❌ 字面量像素。
// 名字(人 / Agent / 群)在资料卡与详情标题里最多两行,再长省略号,悬停 title 看全名;页头与列表行是一行(.gg-pane-title / .gg-list-row-title)。
export const nameClampClass = 'line-clamp-2 [overflow-wrap:anywhere]'
// 资料卡所在的那块(Agent / 人 / 群同一张卡):居中、上方留白一致,三种对象打开时卡片落在同一处。
export const profileBodyClass = 'flex flex-1 items-start justify-center overflow-y-auto !px-6 !pb-6 !pt-[calc(var(--spacing-2xl)*2)]'
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

// @@@ui-ruler 资料卡只吃尺子:头像 --avatar-xl(96)、名字 --font-size-xl、状态/号码 --font-body、
// 间距 4 的倍数、圆角 --r/--r-lg。原来的 120 头像、20px/13px 裸字号、30/14/17/9 间距全部收口。
/** The profile card's one visual language: agent, person and group cards all draw with these. */
export const profileCardStyles = {
  card:
    'gg-c-cpane-card flex flex-col items-center animate-[ggCNaPop_var(--dur-med)_var(--ease)_both]',
  avatarBase:
    'gg-c-cpane-av flex h-[var(--avatar-xl)] w-[var(--avatar-xl)] shrink-0 items-center justify-center overflow-hidden',
  avatarRound: 'rounded-full',
  name:
    'gg-c-cpane-name mt-5 flex max-w-full items-center gap-2 text-center text-xl font-semibold text-[var(--fg)]',
  statusBase:
    'gg-c-cpane-status mt-2 flex items-center gap-2 text-sm text-[var(--muted-fg)]',
  statusStandby: 'standby',
  guguNumber:
    'gg-c-cpane-gugu mt-2 flex items-center gap-2 text-sm text-[var(--muted-fg)]',
  guguNumberLabel: 'gg-c-cpane-gugu-label text-[var(--text-secondary)]',
  originalName: 'max-w-[300px] truncate',
  // #5645 备注行:对齐微信「朋友资料 → 备注」——左标签、右一整条填写框。灰底与铅笔都只在悬停/编辑时出现:
  // 灰底的意思是「这块可以点进去改」,平时不该常驻(owner:颜色要有意义)。
  aliasRow: 'gg-c-cpane-alias mt-5 flex w-[360px] max-w-full items-center gap-4',
  aliasLabel: 'shrink-0 text-sm text-[var(--text-secondary)]',
  aliasBox:
    'group/alias relative flex min-w-0 flex-1 items-center rounded-[var(--radius-control)] bg-transparent transition-[background] duration-[var(--dur-fast)] hover:[background:var(--bg-secondary)] focus-within:[background:var(--bg-secondary)]',
  aliasInput:
    'h-9 w-full min-w-0 border-0 bg-transparent pl-3 pr-9 text-sm text-[var(--fg)] outline-none [font-family:inherit] placeholder:text-[var(--muted-fg)]',
  // owner:铅笔悬停才出现;正在输入时也收起(它只是「可编辑」的提示,不是按钮)
  aliasPen:
    'pointer-events-none absolute right-3 text-[var(--text-tertiary)] opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/alias:opacity-100 group-focus-within/alias:opacity-0',
  actions: 'gg-c-cpane-acts -ml-3 mt-6 flex gap-1',
  // 2026-09-22 按 design.md:「icons dropped into tinted tiles」在反对清单上 —— 原来是三块 130px 带底色圆角砖。
  // 改成一行文字按钮:图标回到文字左边,8px 矩形、无常驻底色(只在 hover/press 出),层级靠字重与留白。
  // 原裁决:与 ContactsPanel 行同款的 --bg-secondary 色块。
  action:
    'gg-c-cact inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border-0 bg-transparent px-3 py-2 text-sm font-medium text-[var(--fg)] !transition-[background] !duration-[var(--dur-fast)] [font-family:inherit] hover:[background:var(--hover)] active:[background:var(--press)] disabled:cursor-default disabled:text-[var(--text-tertiary)]',
  delete:
    'gg-c-cpane-del !-ml-3 !mt-5 inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border-0 bg-transparent !px-3 !py-2 text-sm font-medium text-[var(--danger-fg)] [font-family:inherit] hover:bg-[var(--danger-tint)]',
} as const
