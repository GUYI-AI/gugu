import type { KeyboardEvent, ReactNode } from 'react'
import { Button } from '../ui/Button'
import { ListRowContent } from '../ui/ListRow'

// 「新的请求」里每一种请求(好友 / Agent、入群申请、群邀请)共用的一行与详情底部。
const openOnKey = (open: () => void) => (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open() }
}

// ── Request row (shared) ──────────────────────────────────────────────────────

// @@@6418 好友申请、入群申请、群邀请是同一种表达:头像 · 谁 · 一行说明 · 行尾。行的几何与按钮只此一份,
// 各种请求各自只决定「显示什么」和「点了做什么」。行尾:等我处理的是同意 / 拒绝,其余是灰字状态;点行看详情。
export function RequestRow({
  avatar,
  name,
  sub,
  status,
  onOpen,
  loading,
  onAccept,
  onReject,
  acceptLabel,
  rejectLabel,
  acceptData,
  rejectData,
  rowData,
  selected,
}: {
  avatar: ReactNode
  name: ReactNode
  sub: ReactNode
  status: string | null
  onOpen: () => void
  loading: boolean
  onAccept: () => void
  onReject: () => void
  acceptLabel: string
  rejectLabel: string
  acceptData?: Record<string, string | undefined>
  rejectData?: Record<string, string | undefined>
  rowData?: Record<string, string | undefined>
  /** 它的详情正开着(桌面抽屉)。 */
  selected?: boolean
}) {
  return (
    <div className="nfp-reqrow gg-list-row gg-row" role="button" tabIndex={0} data-selected={selected || undefined} onClick={onOpen} onKeyDown={openOnKey(onOpen)} {...rowData}>
      <ListRowContent leading={avatar} title={<span className="nfp-name">{name}</span>} subtitle={sub} />
      {/* 行尾只放一样东西,右对齐、与头像同一条中线:等我处理的是拒绝 · 同意(次要在左、主要在右,同确认框),其余是灰字状态。 */}
      {status ? <span className="shrink-0 text-[length:var(--font-caption)] text-[var(--muted-fg)]">{status}</span> : <div className="flex shrink-0 gap-2" onClick={(event) => event.stopPropagation()}>
        <Button variant="secondary" size="sm" {...rejectData} onClick={onReject} disabled={loading}>{rejectLabel}</Button>
        <Button variant="primary" size="sm" {...acceptData} onClick={onAccept} disabled={loading}>{acceptLabel}</Button>
      </div>}
    </div>
  )
}

// 详情底部:等我处理的是同一对操作(先收起详情,结果落在那一行上),其余是同一句状态。
// 次序与行上、与全产品的确认框(confirm-action-dialog)一致:次要的在左,主要的在右。
export function DetailFooter({ status, loading, onAccept, onReject, acceptLabel, rejectLabel }: {
  status: string | null
  loading: boolean
  onAccept: () => void
  onReject: () => void
  acceptLabel: string
  rejectLabel: string
}) {
  if (status) return <span data-testid="request-detail-status">{status}</span>
  return (
    <>
      <Button variant="secondary" size="sm" disabled={loading} onClick={onReject}>{rejectLabel}</Button>
      <Button variant="primary" size="sm" disabled={loading} onClick={onAccept}>{acceptLabel}</Button>
    </>
  )
}

