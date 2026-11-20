import { memo, type ReactNode } from 'react'
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
import type { AgentTreeNode } from './contactsAgentTree'
import { SelectionCheckbox } from './ContactSearch'

// 一组 agent 的派生关系画成导图:每个有子 agent 的顶层 agent 连同子孙是一块「家族图」,父在左、子向右展开,同层对齐,
// 父子之间一条平滑曲线。家族图按自己的宽度从左往右排、排满换行(flex-wrap);没有子 agent 的 agent 不单独占一块,
// 在末尾排成多列的头像格(grid auto-fill)。容器变窄(窗口缩小、右边开着抽屉)时全靠 CSS 重排,❌ JS 量宽度。
// 节点 = 头像 + 名字;状态只在头像角上的状态点(Avatar 自带的 AgentStatusBadge:聊天列表、成员列表、消息头像同一套)。

// 一层一列:节点格宽 + 曲线的水平跨度;一个叶子一行。
const NODE_W = 148
const NODE_H = 40
const LEVEL = 212
const SLOT = 44 // = 头像格的行高 auto-rows-[44px]

type Placed = { node: AgentTreeNode; parent: Placed | null; depth: number; slot: number }

/** 叶子按次序排队,父节点放在第一个与最后一个子节点的正中。 */
function place(root: AgentTreeNode): { placed: Placed[]; slots: number; depth: number } {
  const placed: Placed[] = []
  let next = 0
  let depth = 0
  const walk = (node: AgentTreeNode, parent: Placed | null, level: number): Placed => {
    const me: Placed = { node, parent, depth: level, slot: 0 }
    placed.push(me)
    depth = Math.max(depth, level)
    if (node.children.length === 0) me.slot = next++
    else {
      const kids = node.children.map((child) => walk(child, me, level + 1))
      me.slot = (kids[0]!.slot + kids[kids.length - 1]!.slot) / 2
    }
    return me
  }
  walk(root, null, 0)
  return { placed, slots: next, depth }
}

// @@@map-node-memo - 一个 agent 变了只重画那一个节点(同 AgentContactRow @@@agent-row-memo):节点的 props 只有它自己的数据、
// 布尔,和两份身份稳定的函数(onSelect / menuFor 由调用方用 useStableHandler 给)。右键菜单的内容在弹出那一刻才算
// (menuFor),❌ 每次渲染给每个节点一个新的菜单对象 —— 那会让设备心跳、改一个名字都重画整张图。
type NodeProps = {
  contact: ContactUser
  selected: boolean
  onSelect: (contact: ContactUser) => void
  menuFor: (contact: ContactUser) => ContactRowMenuActions | undefined
  /** 有右键菜单(自己的 agent)。 */
  hasMenu: boolean
  /** 有子节点:名字后面接一截连线到格子右边,曲线从格子右边出发 —— 名字长短不一,出口仍在同一条竖线上(纯 CSS)。 */
  stem?: boolean
  dim?: boolean
  label?: (contact: ContactUser, name: string) => ReactNode
  /** 多选建群时:true / false = 可勾选、勾没勾;缺席 = 不可勾选(别人的 agent)。 */
  picked?: boolean
}

const MapNode = memo(function MapNode({ contact, selected, onSelect, menuFor, hasMenu, stem, dim, label, picked }: NodeProps) {
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
      >
        {picked === undefined ? null : <SelectionCheckbox checked={picked} />}
        <Avatar name={name} avatarUrl={contact.avatar} seed={contact.id} size="sm" isAgent agentStatus={tone ?? undefined} />
        <span data-map-name className="min-w-0 truncate text-[length:var(--font-body)] text-[var(--fg)]">{label ? label(contact, name) : name}</span>
      </div>
      {stem ? <span aria-hidden="true" className="h-[1.5px] min-w-2 flex-1 bg-[var(--border-strong)]" /> : null}
      {menuPos ? <NodeMenu contact={contact} menuFor={menuFor} x={menuPos.x} y={menuPos.y} onClose={closeMenu} /> : null}
    </div>
  )
})

const pickedOf = (pick: MapProps['pick'], contact: ContactUser) => (pick?.can(contact) ? pick.ids.has(contact.id) : undefined)

function NodeMenu({ contact, menuFor, x, y, onClose }: { contact: ContactUser; menuFor: NodeProps['menuFor']; x: number; y: number; onClose: () => void }) {
  const menu = menuFor(contact)
  return menu ? <ContactRowContextMenu x={x} y={y} onClose={onClose} {...menu} /> : null
}

type MapProps = {
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

function FamilyMap({ root, selectedId, onSelect, menuFor, dimmed, label, pick }: MapProps & { root: AgentTreeNode }) {
  const { placed, slots, depth } = place(root)
  const at = (p: Placed) => ({ x: p.depth * LEVEL, y: p.slot * SLOT + (SLOT - NODE_H) / 2 })
  const width = depth * LEVEL + NODE_W
  const height = slots * SLOT
  // 父节点格子的右边中点 → 子节点的左边中点,三次贝塞尔,两个控制点各在跨度的一半处。
  const curve = (p: Placed) => {
    const a = at(p.parent!)
    const b = at(p)
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mid = (x1 + x2) / 2
    return `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
  }
  return (
    // 一个家族比容器还宽(很深)时,只有它自己横向滚动,别的家族照常排。节点用 SVG foreignObject 的 x/y 摆位(几何在属性里,❌ 内联 style)。
    <div data-testid="agent-family-map" className="max-w-full overflow-x-auto">
      <svg className="block" width={width} height={height}>
        <g data-map-edges aria-hidden="true">
          {placed.filter((p) => p.parent).map((p) => (
            <path key={p.node.contact.id} d={curve(p)} fill="none" stroke="var(--border-strong)" strokeWidth={1.5} />
          ))}
        </g>
        {placed.map((p) => {
          const { x, y } = at(p)
          return (
            <foreignObject key={p.node.contact.id} x={x} y={y} width={NODE_W} height={NODE_H}>
              <MapNode contact={p.node.contact} stem={p.node.children.length > 0} dim={dimmed?.(p.node.contact)} label={label} picked={pickedOf(pick, p.node.contact)} selected={p.node.contact.id === selectedId} onSelect={onSelect} menuFor={menuFor} hasMenu={!!menuFor(p.node.contact)} />
            </foreignObject>
          )
        })}
      </svg>
    </div>
  )
}

export function AgentMindMap({ forest, ...map }: MapProps & { forest: readonly AgentTreeNode[] }) {
  const families = forest.filter((node) => node.children.length > 0)
  const singles = forest.filter((node) => node.children.length === 0)
  return (
    <div data-testid="agent-mind-map" className="!py-2">
      {families.length > 0 ? (
        <div className="flex flex-wrap items-start gap-x-12 gap-y-6">
          {families.map((root) => <FamilyMap key={root.contact.id} root={root} {...map} />)}
        </div>
      ) : null}
      {singles.length > 0 ? (
        <div className="!mt-4 grid auto-rows-[44px] grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-2">
          {singles.map((node) => (
            <MapNode key={node.contact.id} contact={node.contact} dim={map.dimmed?.(node.contact)} label={map.label} picked={pickedOf(map.pick, node.contact)} selected={node.contact.id === map.selectedId} onSelect={map.onSelect} menuFor={map.menuFor} hasMenu={!!map.menuFor(node.contact)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
