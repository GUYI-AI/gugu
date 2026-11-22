import { useGroupDisplayName } from '../../hooks/useGroupDisplayName'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { PublicGroupInviteGroup } from '@gugu/core/shared/types/contacts'
import { contactsService, type JoinGroupByIdRefusal } from '../../lib/contacts'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { useReplica, useReplicaFetching, refreshFailure, retryOf } from '../../lib/replica'
import { useDebounce } from '@renderer/lib/hooks/useDebounce'
import { Button } from '../ui/Button'
import { Illustration } from '../ui/Illustration'
import { ListRowContent } from '../ui/ListRow'
import { PaneEmptyState } from '../ui/PaneEmptyState'
import { SearchField } from '../ui/SearchField'
import { SectionLabel } from '../ui/SectionLabel'
import { publicGroupInvite } from '../../lib/publicGroupInvite'
import { Check } from '@/lib/icons'
import { cn } from '@/lib/cn'

const joinGroupLog = rendererLogger('contacts/join-group-by-id')

// 被拒的三种结局 → 各自的产品文案。RPC 报的是稳定 ASCII 标识,❌ 不把它原样显给用户:
// 那既是内部措辞、又不可翻译,而且服务端一改措辞用户就看到裸报错。
const REFUSAL_COPY_KEY: Record<JoinGroupByIdRefusal, string> = {
  group_self_serve_closed: 'joinGroup.refusedSelfServeClosed',
  group_invite_only: 'joinGroup.refusedInviteOnly',
  group_not_found: 'joinGroup.refusedNotFound',
}

// 几何走类名与 token,❌ 不写 inline style:那是 @@@ui-ruler 棘轮盯的债务,只减不增。
const noteClass = 'pl-2 pr-2 pt-1 text-[length:var(--font-caption)] leading-[var(--lh-body)] text-[var(--text-secondary)]'
const stateClass = 'inline-flex items-center gap-1.5 whitespace-nowrap text-[length:var(--font-body)] text-[var(--text-secondary)]'

// @@@typeahead 与「添加联系人」同一套节制(参数与出处见 AddFriendSearch 的 @@@typeahead):群号是整数,
// 号段从 200001 起(chat.public_chat_id_seq),所以 6 位以上才可能是一个群;停顿 400 ms 才查,Enter 立即查。
// 查询走 publicGroupInvite 这一个 replica:按群号各占一格,晚到的旧答案落不到当前框上,同号再查命中缓存。
const DEBOUNCE_MS = 400
const PENDING_SHOW_MS = 200
const MIN_DIGITS = 6
const idOf = (text: string): number | null => {
  const trimmed = text.trim()
  if (!/^\d{1,9}$/.test(trimmed)) return null
  const id = Number.parseInt(trimmed, 10)
  return id > 0 ? id : null
}

/**
 * 按群号加群 —— 与「加好友」对称的那条路。
 *
 * 加好友是:搜咕咕号 → 看到人 → 发申请 → 对方同意。这里是同一个形状,只是主语换成群,版式也和加好友同一套:
 * 搜索框、分组标题、结果行、行内状态。
 *
 * ⚠️ 这条路**只产生申请**,即使群的 join_mode 是 open 也不直接入群。
 * 群号是严格递增的序列(`chat.public_chat_id_seq`,START 200001),顺着数就能枚举全产品的群 ——
 * 按群号直接入群等于谁都能把所有 open 群刷一遍。判断落在 RPC 那头(见迁移
 * 20260906003846_join_group_by_public_id.sql),这里的按钮文案必须跟它一致:恒为「申请加入」。
 * ❌ 别照抄 GroupInviteCard:那张卡是给邀请链接那条路做的,对 open 群显示「加入」——
 *    在这条路上就是一句假话(点下去得到的是 pending)。
 *
 * 「群主没开自助加入」/「仅限邀请加入」这两种拒绝**不在客户端预判**:
 * lookup_public_group 根本不返回 invite_link_enabled,预判就得靠猜。让服务端判、
 * 客户端按它回的稳定标识选自己的文案 —— 宁可点一下才知道,也不画一个理由不明的灰按钮。
 * 拒绝是一条规则不是用户的错:用中性色说明下一步,不用红字。
 */
// headless:弹窗形态(AddFriendSearch 不渲头部)时,搜索框上面得自己补一段间距,
// 否则它直接顶在弹窗边框上。有头部时头部已带 pb-3,再补就成了双倍。
export function JoinGroupById({ headless }: { headless?: boolean }) {
  const { t } = useTranslation('contacts')
  const [query, setQuery] = useState('')
  const typed = useDebounce(query, DEBOUNCE_MS)
  const [asked, setAsked] = useState<number | null>(null)
  const typedId = idOf(typed)
  const lookupId = asked ?? (typedId !== null && typed.trim().length >= MIN_DIGITS ? typedId : null)
  const found = useReplica(publicGroupInvite, lookupId === null ? null : [lookupId])
  const fetching = useReplicaFetching(publicGroupInvite, lookupId === null ? null : [lookupId])
  const slow = useDebounce(fetching, PENDING_SHOW_MS) && fetching
  // 申请之后服务端回的那一份群状态(pending / 已在群里),盖过查询那一刻的读数。
  const [after, setAfter] = useState<PublicGroupInviteGroup | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [justRequested, setJustRequested] = useState(false)

  const looked = found.state === 'value' ? found.value.group : null
  const group = after && looked && after.public_id === looked.public_id ? after : looked
  const groupName = useGroupDisplayName(group)
  const invalid = query.trim() !== '' && idOf(query) === null

  const change = (value: string) => {
    setQuery(value); setAsked(null); setAfter(null); setRefusal(null); setJoinError(null); setJustRequested(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key !== 'Enter') return
    event.preventDefault()
    const id = idOf(query)
    if (id === null) return
    if (group && group.public_id === id && !alreadyIn && !pending && !refusal) { void handleJoin(); return }
    if (id === lookupId) void publicGroupInvite.refresh(id)
    setAsked(id)
  }

  async function handleJoin() {
    if (!group || joining) return
    setJoining(true)
    setJoinError(null)
    try {
      const res = await contactsService.requestGroupJoinByPublicId(group.public_id)
      if (res.status === 'refused') {
        // 说清是**哪一种**拒绝,❌ 不吞成笼统的「加入失败」——
        // 用户要能分辨「群主没开自助加入」和「这个群只收邀请」,两者的下一步不一样。
        setRefusal(t(REFUSAL_COPY_KEY[res.reason]))
        return
      }
      setAfter(res.group)
      setJustRequested(res.status !== 'joined')
    } catch (err) {
      joinGroupLog.error({ publicId: group.public_id, error: String(err) }, 'group join request failed')
      setJoinError(messageForUser(err))
    } finally {
      setJoining(false)
    }
  }

  const alreadyIn = group?.is_member === true
  const pending = group?.join_request_status === 'pending'
  const failure = lookupId !== null ? refreshFailure(found) : null
  // 原因进日志,界面上复用去敏后的同一原因。
  useEffect(() => {
    if (failure) joinGroupLog.error({ publicId: lookupId, error: String(failure) }, 'lookup public group failed')
  }, [failure, lookupId])

  let body
  if (invalid) {
    body = <div data-testid="join-group-invalid" className={cn(noteClass, 'pt-2')}>{t('joinGroup.invalidId')}</div>
  } else if (lookupId === null) {
    body = (
      <div className="mt-10">
        <PaneEmptyState art={<Illustration name="join-group" className="w-[170px]" />} caption={t('joinGroup.emptyTitle')} hint={t('joinGroup.emptyHint')} />
      </div>
    )
  } else if (failure) {
    body = (
      <div role="alert" data-testid="join-group-lookup-failed" className="mt-4 flex items-center gap-3 rounded-[var(--radius-surface)] border border-[var(--border-color)] p-3 text-[length:var(--font-body)] text-[var(--text-secondary)]">
        <span className="flex-1">{t('joinGroup.lookupFailed')} {messageForUser(failure)}</span>
        <Button variant="secondary" size="sm" onClick={retryOf(found)}>{t('common.retry')}</Button>
      </div>
    )
  } else if (found.state !== 'value') {
    body = slow ? (
      <div aria-busy="true" data-testid="join-group-pending" className="mt-3 flex items-center gap-3 px-2 py-2">
        <div className="flex flex-1 flex-col gap-2"><div className="h-2.5 w-1/3 rounded-full bg-[var(--muted)]" /><div className="h-2 w-1/5 rounded-full bg-[var(--muted)]" /></div>
        <div className="h-7 w-28 rounded-[var(--radius-control)] bg-[var(--muted)]" />
      </div>
    ) : null
  } else if (!group) {
    body = (
      <div className="mt-10" data-testid="join-group-not-found">
        <PaneEmptyState art={<Illustration name="no-match" className="w-[112px]" />} caption={t('joinGroup.notFound', { id: lookupId })} hint={t('joinGroup.notFoundHint')} />
      </div>
    )
  } else {
    const right = alreadyIn
      ? <span className={stateClass}>{t('joinGroup.joined')}</span>
      : pending
        ? <span className={stateClass} data-testid="join-group-pending-state"><Check size={14} aria-hidden />{t('joinGroup.pending')}</span>
        : refusal
          ? <span className={stateClass}>{t('joinGroup.cannotRequest')}</span>
          : <Button variant="primary" size="sm" disabled={joining} data-testid="join-group-request-button" onClick={() => { void handleJoin() }}>
              {joining ? t('joinGroup.requesting') : joinError ? t('common.retry') : t('joinGroup.request')}
            </Button>
    body = (
      <>
        <SectionLabel className="!mt-3">{t('joinGroup.resultLabel')}</SectionLabel>
        {/* ❌ 不放头像:Avatar 的 variant='group' 在既无群头像、又无成员头像时是**刻意的空态**
            (群不是一张脸,不给它生成),渲染出来就是个像「图挂了」的空框。lookup_public_group
            两样都不返回 ⇒ 这里必然踩中那个空态。邀请链接那条路的确认卡同样不放头像,跟它一致。 */}
        <div data-testid="join-group-result" className="gg-list-row gg-row">
          <ListRowContent title={groupName} subtitle={t('joinGroup.summary', { number: group.public_id, count: group.member_count })} />
          {right}
        </div>
        {refusal ? <div data-testid="join-group-refused" className={noteClass}>{refusal}</div> : null}
        {joinError ? <div role="alert" data-testid="join-group-error" className={cn(noteClass, 'text-[var(--danger-fg)]')}>{joinError}</div> : null}
        {justRequested && pending ? <div data-testid="join-group-requested" className={noteClass}>{t('joinGroup.requestedHint', { name: groupName })}</div> : null}
      </>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={cn('mx-auto flex w-full max-w-[560px] flex-col px-4 pb-6', headless && 'pt-3')}>
        <SearchField
          data-testid="join-group-id-input"
          inputMode="numeric"
          value={query}
          placeholder={t('joinGroup.searchPlaceholder')}
          aria-label={t('joinGroup.searchPlaceholder')}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          clearLabel={t('friendSearch.clearSearch')}
          onClear={() => change('')}
        />
        {body}
      </div>
    </div>
  )
}
