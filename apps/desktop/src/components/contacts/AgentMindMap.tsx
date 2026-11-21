import { Fragment, memo, useState, type ReactNode } from 'react'
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
import type { AgentTreeNode } from './contactsAgentTree'
import { SelectionCheckbox } from './ContactSearch'

// 一组 agent 的派生关系画成导图:每个有子 agent 的顶层 agent 连同子孙是一块「家族图」,父在左、子向右展开,同层对齐,
// 父子之间一条平滑曲线。家族图按自己的宽度从左往右排、排满换行(flex-wrap);没有子 agent 的 agent 不单独占一块,
// 在末尾排成一行行的头像格(flex-wrap,每格至少 160px:短名字照样对得齐,长名字不截)。容器变窄(窗口缩小、右边开着抽屉)时
// 全靠 CSS 重排,❌ JS 量宽度。
// 节点 = 头像 + 名字;状态只在头像角上的状态点(Avatar 自带的 AgentStatusBadge:聊天列表、成员列表、消息头像同一套)。

// @@@map-columns - 一层一列,列与连线列交替排在一行网格里(grid-auto-columns 轮流取 minmax(148px, max-content) 与
// CURVE_W)。列宽从 148px(原先写死的节点宽)往上长到这一列最长的名字;地方不够时网格把余下的宽度平均分给各列、
// 名字短的列先长满 —— 只截最长的那几个名字,❌ 按比例一起收窄(那样短名字也被截)。再窄就这一个家族横向滚动。
// 多选时节点前多一个勾选圈,最窄列宽跟着加上它(176px),❌ 让勾选圈挤掉名字。
// 节点在列里按次序排着(撑出列宽,高度为 0),各自用 translate 挪到自己的行上:位移写在 data-dy 属性里,CSS 用 attr() 读
// (几何在属性里,❌ 内联 style)。展开 / 收起只改 translate、opacity 和连线的 d,三样都过渡 —— ❌ 动 top/height 这类
// 布局属性(那样每一帧都要重排整页)。
const CURVE_W = 64
const SLOT = 44 // 一个叶子一行 = 头像格的行高 h-[44px]
const HALF = SLOT / 2 // 父节点在子节点正中,可能落在半行上
// 一个 agent 的子 agent 超过 FOLD_OVER 个时只露前 FOLD_SHOW 个,其余收成一个「…+N」节点。
const FOLD_OVER = 5
const FOLD_SHOW = 4
const MOVE = '[translate:0_attr(data-dy_px)] [transition:translate_var(--dur-slow)_var(--ease-spring),opacity_var(--dur-slow)_var(--ease-spring)]'

/** 节点或「…+N」节点。hidden = 收在某个「…+N」里:停在那个节点的行上、透明、不接指针。 */
type Placed = { key: string; node: AgentTreeNode | null; parent: Placed | null; depth: number; slot: number; hidden: boolean; fold?: { count: number; open: boolean } }

/** 叶子按次序排队,父节点放在第一个与最后一个子节点的正中;收起的子孙都停在「…+N」那一行。 */
function place(root: AgentTreeNode, open: ReadonlySet<string>): { placed: Placed[]; slots: number; depth: number } {
  const placed: Placed[] = []
  let next = 0
  let depth = 0
  const walk = (node: AgentTreeNode, parent: Placed | null, level: number, anchor: Placed | null): Placed => {
    const me: Placed = { key: node.contact.id, node, parent, depth: level, slot: anchor?.slot ?? 0, hidden: !!anchor }
    placed.push(me)
    depth = Math.max(depth, level)
    if (anchor) node.children.forEach((child) => walk(child, me, level + 1, anchor))
    else if (node.children.length === 0) me.slot = next++
    else {
      // 收起与展开走同一个次序(前几个子节点、「…+N」、其余子节点):节点在列里的次序不变,只有 translate 在变 ——
      // 次序一变,节点在列里的原位就跳了,过渡也就接不上。
      const folds = node.children.length > FOLD_OVER
      const unfolded = !folds || open.has(node.contact.id)
      const kids = node.children.slice(0, folds ? FOLD_SHOW : undefined).map((child) => walk(child, me, level + 1, null))
      if (folds) {
        const fold: Placed = { key: `fold:${node.contact.id}`, node: null, parent: me, depth: level + 1, slot: unfolded ? 0 : next++, hidden: false, fold: { count: node.children.length - FOLD_SHOW, open: unfolded } }
        placed.push(fold)
        const rest = node.children.slice(FOLD_SHOW).map((child) => walk(child, me, level + 1, unfolded ? null : fold))
        if (unfolded) { kids.push(...rest); fold.slot = next++ }
        kids.push(fold)
      }
      me.slot = (kids[0]!.slot + kids[kids.length - 1]!.slot) / 2
    }
    return me
  }
  walk(root, null, 0, null)
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
  const { t } = useTranslation('contacts')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) => setOpen((now) => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next })
  const { placed, slots, depth } = place(root, open)
  const height = slots * SLOT
  const levels = Array.from({ length: depth + 1 }, (_, level) => placed.filter((p) => p.depth === level))
  // 父节点格子的右边中点 → 子节点的左边中点,三次贝塞尔,两个控制点各在跨度的一半处。
  const curve = (p: Placed) => {
    const y1 = p.parent!.slot * SLOT + HALF, y2 = p.slot * SLOT + HALF, mid = CURVE_W / 2
    return `M0 ${y1}C${mid} ${y1} ${mid} ${y2} ${CURVE_W} ${y2}`
  }
  return (
    // 一个家族收到最窄还比容器宽(很深)时,只有它自己横向滚动,别的家族照常排。
    <div data-testid="agent-family-map" className={cn('grid max-w-full grid-flow-col overflow-x-auto overflow-y-hidden', pick ? 'auto-cols-[minmax(176px,max-content)_64px]' : 'auto-cols-[minmax(148px,max-content)_64px]')}>
      {levels.map((column, level) => (
        <Fragment key={level}>
          {level > 0 ? (
            <svg aria-hidden="true" className="block" width={CURVE_W} height={height}>
              <g data-map-edges>
                {column.map((p) => (
                  <path key={p.key} d={curve(p)} opacity={p.hidden ? 0 : 1} fill="none" stroke="var(--border-strong)" strokeWidth={1.5}
                    className="[transition:d_var(--dur-slow)_var(--ease-spring),opacity_var(--dur-slow)_var(--ease-spring)]" />
                ))}
              </g>
            </svg>
          ) : null}
          <div className="min-w-0">
            <div className="h-0">
              {column.map((p, index) => (
                <div key={p.key} inert={p.hidden} data-dy={(p.slot - index) * SLOT} className={cn('flex h-[44px] items-center', MOVE, p.hidden && 'opacity-0')}>
                  <div className="h-[40px] w-full min-w-0">
                    {p.fold ? (
                      <FoldNode count={p.fold.count} open={p.fold.open} label={t(p.fold.open ? 'sectionPane.showLess' : 'sectionPane.showMore', { count: p.fold.count })} onToggle={() => toggle(p.parent!.key)} />
                    ) : (
                      <MapNode contact={p.node!.contact} stem={p.node!.children.length > 0} dim={dimmed?.(p.node!.contact)} label={label} picked={pickedOf(pick, p.node!.contact)} selected={p.node!.contact.id === selectedId} onSelect={onSelect} menuFor={menuFor} hasMenu={!!menuFor(p.node!.contact)} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/** 「…+N」/ 收起:与节点同一套行态(gg-row 的悬浮 / 按下),字用次级色。 */
function FoldNode({ count, open, label, onToggle }: { count: number; open: boolean; label: string; onToggle: () => void }) {
  return (
    <div className="flex h-full w-full min-w-0 items-center">
      <div role="button" tabIndex={0} title={label} aria-expanded={open} data-map-fold={count} onClick={onToggle} onKeyDown={rowKeyActivate(onToggle)}
        className="gg-row flex h-full w-fit cursor-pointer items-center rounded-[var(--radius-control)] !px-2 text-[length:var(--font-body)] text-[var(--muted-fg)]">
        {open ? label : `…+${count}`}
      </div>
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
        <div className="!mt-4 flex flex-wrap gap-x-2">
          {singles.map((node) => (
            <div key={node.contact.id} className="h-[44px] min-w-[160px] max-w-full">
              <MapNode contact={node.contact} dim={map.dimmed?.(node.contact)} label={map.label} picked={pickedOf(map.pick, node.contact)} selected={node.contact.id === map.selectedId} onSelect={map.onSelect} menuFor={map.menuFor} hasMenu={!!map.menuFor(node.contact)} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
