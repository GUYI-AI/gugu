import { memo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAgentDisplayStatus } from '@/hooks/useAgentDisplayStatus'
import { useRowContextMenu } from '@/hooks/useRowContextMenu'
import { displayName } from '@/lib/contactsListSort'
import { cn } from '@/lib/cn'
import { Avatar } from '../Avatar'
import { useShownAgentContactStatus } from '../contactAgentTone'
import { ContactRowContextMenu, type ContactRowMenuActions } from './ContactRowActions'
import { rowKeyActivate } from './contactsPanelStyles'
import { agentHomeLine, agentNodeDrag, type AgentTreeNode } from './contactsAgentTree'
import { SelectionCheckbox } from './ContactSearch'
import { ContactsGrid } from './ContactsGrid'

// 一组 agent 按派生关系排在通讯录的列轨上(ContactsGrid:最多 4 列,随正文宽度 4→3→2→1):
// 每个有子 agent 的顶层 agent 连同子孙是一个「家族」,只占一格,在格里从上往下画成大纲 —— 父在上,子缩进一级,
// ├ / └ 连接线与 │ 竖线是纯 CSS 边框;一行家族没排满时,剩下的宽度分给这一行的家族(ContactsGrid fill),名字截在可用宽度上。
// 没有子 agent 的 agent 各占一格,排在家族后面。正文再窄也不横向滚动。
// 节点 = 头像 + 名字;状态只在头像角上的那一枚(Avatar 自带的 AgentStatusCorner:聊天列表、成员列表、消息头像同一套)。

// 一个 agent 的子 agent 超过 FOLD_OVER 个时只露前 FOLD_SHOW 个,其余收成一个「…+N」行,点开就地展开。
const FOLD_OVER = 5
const FOLD_SHOW = 4

/** 大纲里的一行:一个节点,或某个父节点的「…+N」。rails[k] = 深度 k+1 的那个祖先下面还有兄弟(它那一格画 │)。 */
type Line = { key: string; node: AgentTreeNode | null; depth: number; rails: boolean[]; last: boolean; fold?: { parent: string; count: number; open: boolean } }

function outline(root: AgentTreeNode, open: ReadonlySet<string>): Line[] {
  const out: Line[] = []
  const walk = (node: AgentTreeNode, depth: number, rails: boolean[], last: boolean) => {
    out.push({ key: node.contact.id, node, depth, rails, last })
    const folds = node.children.length > FOLD_OVER
    const unfolded = !folds || open.has(node.contact.id)
    const kids = unfolded ? node.children : node.children.slice(0, FOLD_SHOW)
    const below = depth > 0 ? [...rails, !last] : rails
    kids.forEach((child, index) => walk(child, depth + 1, below, !folds && index === kids.length - 1))
    if (folds) out.push({ key: `fold:${node.contact.id}`, node: null, depth: depth + 1, rails: below, last: true, fold: { parent: node.contact.id, count: node.children.length - FOLD_SHOW, open: unfolded } })
  }
  walk(root, 0, [], true)
  return out
}

// @@@outline-rails - 竖线要落在父节点头像的正中:节点行左内距 8px + 头像半宽(多选时最前面是勾选圈,对它的正中)。
// 每级缩进 = 竖线位置 + 4px,横臂 12px 伸过子节点的左内距。一行 44px(节点 40px + 上下 2px),竖线一格一格接起来。
const RAIL = 'absolute left-[var(--rail-x)] border-l-[1.5px] border-[var(--border-strong)]'
const INDENT = 'relative h-full w-[var(--indent)] shrink-0'
function Rails({ line }: { line: Line }) {
  if (line.depth === 0) return null
  return (
    <span aria-hidden="true" className="flex h-full shrink-0">
      {line.rails.map((rail, index) => <span key={index} className={INDENT}>{rail ? <span className={cn(RAIL, 'inset-y-0')} /> : null}</span>)}
      <span className={INDENT}>
        <span className={cn(RAIL, 'top-0', line.last ? 'h-1/2' : 'h-full')} />
        <span className="absolute left-[var(--rail-x)] top-1/2 w-[12px] border-t-[1.5px] border-[var(--border-strong)]" />
      </span>
    </span>
  )
}

// @@@map-node-memo - 一个 agent 变了只重画那一个节点(同 AgentContactRow @@@agent-row-memo):节点的 props 只有它自己的数据、
// 布尔,和两份身份稳定的函数(onSelect / menuFor 由调用方用 useStableHandler 给)。右键菜单的内容在弹出那一刻才算
// (menuFor),❌ 每次渲染给每个节点一个新的菜单对象 —— 那会让设备心跳、改一个名字都重画整页。
type NodeProps = {
  contact: ContactUser
  selected: boolean
  onSelect: (contact: ContactUser) => void
  menuFor: (contact: ContactUser) => ContactRowMenuActions | undefined
  /** 有右键菜单(自己的 agent)。 */
  hasMenu: boolean
  dim?: boolean
  label?: (contact: ContactUser, name: string) => ReactNode
  /** 多选建群时:true / false = 可勾选、勾没勾;缺席 = 不可勾选(别人的 agent)。 */
  picked?: boolean
}

const AgentNode = memo(function AgentNode({ contact, selected, onSelect, menuFor, hasMenu, dim, label, picked }: NodeProps) {
  const { status, presence } = useAgentDisplayStatus(contact.id)
  const { tone } = useShownAgentContactStatus(contact.id, status, presence.presentation)
  const name = useShownAgentName({ name: displayName(contact), agentType: contact.agent_type, createdAt: contact.created_at ?? undefined })
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  return (
    <div className={cn('flex h-full w-full min-w-0 items-center', dim && 'opacity-40')}>
      <div
        role="button"
        tabIndex={0}
        title={name}
        data-contact-id={contact.id}
        data-selected={selected || undefined}
        data-contact-option={picked === undefined ? undefined : contact.id}
        aria-pressed={picked}
        className="gg-row flex h-full w-fit min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-[var(--radius-control)] !px-2"
        onClick={() => onSelect(contact)}
        onKeyDown={rowKeyActivate(() => onSelect(contact))}
        onContextMenu={hasMenu ? onContextMenu : undefined}
        {...agentNodeDrag(contact.id, name, hasMenu)}
      >
        {picked === undefined ? null : <SelectionCheckbox checked={picked} />}
        <Avatar name={name} avatarUrl={contact.avatar} seed={contact.id} size="sm" isAgent agentStatus={tone ?? undefined} />
        <span data-agent-name className="min-w-0 truncate text-[length:var(--font-body)] text-[var(--fg)]">{label ? label(contact, name) : name}</span>
      </div>
      {menuPos ? <NodeMenu contact={contact} menuFor={menuFor} x={menuPos.x} y={menuPos.y} onClose={closeMenu} /> : null}
    </div>
  )
})

function NodeMenu({ contact, menuFor, x, y, onClose }: { contact: ContactUser; menuFor: NodeProps['menuFor']; x: number; y: number; onClose: () => void }) {
  const menu = menuFor(contact)
  return menu ? <ContactRowContextMenu x={x} y={y} onClose={onClose} {...menu} /> : null
}

type FamiliesProps = {
  /** 搜索时:没命中的节点淡下去(家族仍画全,看得出命中的那个在哪)。 */
  dimmed?: (contact: ContactUser) => boolean
  /** 搜索时:名字里命中的字满墨。 */
  label?: (contact: ContactUser, name: string) => ReactNode
  /** 多选建群:勾了哪些、哪些能勾(自己的 agent)。 */
  pick?: { ids: ReadonlySet<string>; can: (contact: ContactUser) => boolean }
  selectedId: string | null
  onSelect: (contact: ContactUser) => void
  menuFor: (contact: ContactUser) => ContactRowMenuActions | undefined
}

function Node({ contact, dimmed, label, pick, selectedId, onSelect, menuFor }: FamiliesProps & { contact: ContactUser }) {
  return <AgentNode contact={contact} dim={dimmed?.(contact)} label={label} picked={pick?.can(contact) ? pick.ids.has(contact.id) : undefined}
    selected={contact.id === selectedId} onSelect={onSelect} menuFor={menuFor} hasMenu={!!menuFor(contact)} />
}

function Family({ root, ...props }: FamiliesProps & { root: AgentTreeNode }) {
  const { t } = useTranslation('contacts')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) => setOpen((now) => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next })
  return (
    <div data-testid="agent-family" className="min-w-0">
      {outline(root, open).map((line) => (
        <div key={line.key} className="flex h-[44px] min-w-0 items-center" {...(line.node ? agentHomeLine(line.node.contact.id) : undefined)}>
          <Rails line={line} />
          <div className="h-[40px] min-w-0 flex-1">
            {line.fold ? (
              <FoldRow count={line.fold.count} open={line.fold.open} label={t(line.fold.open ? 'sectionPane.showLess' : 'sectionPane.showMore', { count: line.fold.count })} onToggle={() => toggle(line.fold!.parent)} />
            ) : <Node contact={line.node!.contact} {...props} />}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 「…+N」/ 收起:与节点同一套行态(gg-row 的悬浮 / 按下),字用次级色。 */
function FoldRow({ count, open, label, onToggle }: { count: number; open: boolean; label: string; onToggle: () => void }) {
  return (
    <div role="button" tabIndex={0} title={label} aria-expanded={open} data-agent-fold={count} onClick={onToggle} onKeyDown={rowKeyActivate(onToggle)}
      className="gg-row flex h-full w-fit cursor-pointer items-center rounded-[var(--radius-control)] !px-2 text-[length:var(--font-body)] text-[var(--muted-fg)]">
      {open ? label : `…+${count}`}
    </div>
  )
}

export function AgentFamilies({ forest, ...props }: FamiliesProps & { forest: readonly AgentTreeNode[] }) {
  const families = forest.filter((node) => node.children.length > 0)
  const singles = forest.filter((node) => node.children.length === 0)
  return (
    <div data-testid="agent-families" className={cn('!py-2', props.pick
      ? '[--rail-x:calc(8px_+_var(--avatar-xs)/2)]' : '[--rail-x:calc(8px_+_var(--avatar-sm)/2)]', '[--indent:calc(var(--rail-x)_+_4px)]')}>
      {families.length > 0 ? <ContactsGrid fill className="items-start gap-y-4">{families.map((root) => <Family key={root.contact.id} root={root} {...props} />)}</ContactsGrid> : null}
      {singles.length > 0 ? (
        <ContactsGrid className={cn(families.length > 0 && '!mt-4 border-t border-[var(--border)] !pt-4')}>
          {singles.map((node) => <div key={node.contact.id} className="h-[44px] min-w-0" {...agentHomeLine(node.contact.id)}><Node contact={node.contact} {...props} /></div>)}
        </ContactsGrid>
      ) : null}
    </div>
  )
}
