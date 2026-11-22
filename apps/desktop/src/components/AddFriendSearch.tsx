import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useContactsStore } from '../store/contactsContext'
import { useAuth } from '../store/auth'
import { userSearch } from '../lib/contactsReplicas'
import { useReplica, useReplicaFetching, refreshFailure, retryOf } from '../lib/replica'
import { createContactQrPayload, createGuguQrUrl, parseGuguQrPayload } from '@gugu/core/shared/qrPayload'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useDebounce } from '@renderer/lib/hooks/useDebounce'
import { Avatar } from './Avatar'
import { Button } from './ui/Button'
import { Field } from './ui/Field'
import { Illustration } from './ui/Illustration'
import { ListRowContent } from './ui/ListRow'
import { PaneEmptyState } from './ui/PaneEmptyState'
import { SectionLabel } from './ui/SectionLabel'
import { CopyValue } from './CopyValue'
import { useTranslation } from 'react-i18next'
import { JoinGroupById } from './contacts/JoinGroupById'
import { SearchField } from './ui/SearchField'
import { useBackLayer } from './ui/sheetStack'
import { InviteFriendsPreview, PersonalSharePreview } from './referralPreview/ReferralPreview'
import { Check, QrCode } from '@/lib/icons'
import { cn } from '@/lib/cn'

// @@@add-friend-unify (#加人链路统一) AddFriendSearch 是「搜索用户 → 发好友申请」的唯一实现，
// 同时被 ContactsPanel 的「添加联系人」路由（面板态，showHeader）与 ChatListPanel 的「+ 添加联系人」
// 弹窗（modal 壳，showHeader=false）复用。服务层与组件层都只有一条链路。

// ── header frame (panel mode) — 与 NewFriendsPanel 头部同款 ────────────────────
const headClass = 'afs-head window-drag-region flex shrink-0 items-center gap-[9px] px-4 pb-3 pt-4 text-[length:var(--font-title)] font-semibold [-webkit-app-region:no-drag]'
const backButtonClass = 'afs-back-btn gg-pressable -my-2.5 -ml-2.5 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] border-none bg-transparent p-0 text-[var(--text-primary)]'
const captionClass = 'text-[length:var(--font-caption)] leading-[var(--lh-body)] text-[var(--text-secondary)]'

function BackChevron() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="m15 5-6 7 6 7" />
    </svg>
  )
}

// @@@typeahead 边打边搜(owner 11-22:要节制、做优化,参考 Telegram / QQ / GitHub)。参数与出处写在 PR 里:
//   · 停顿 300 ms 才发(GitHub <auto-complete>、Telegram Web K 都是 300);Enter 立即发,不等。
//   · 最少字数:含汉字 1 个即可(一个字就是一个有意义的名字),其余 2 个(1 个拉丁字母只会捞出一屏噪声)。
//   · 输入法拼写(composition)期间不发、Enter 不提交;拼写结束(compositionend)那一刻才算一次输入。
//   · 旧请求:userSearch 按查询串各占一格(replica 键),晚到的旧答案只落进自己那一格,永远画不到当前框上 ——
//     不用自己记序号,也不用 AbortController。同一串再搜直接命中那一格的缓存。
//   · 加载态:请求超过 200 ms 才出骨架行(快的回答不闪);换词时上一批结果留在原地变淡(replica keepPrevious)。
const DEBOUNCE_MS = 300
const PENDING_SHOW_MS = 200
const HAN = /\p{Script=Han}/u
const searchable = (text: string) => text.length >= (HAN.test(text) ? 1 : 2)

type Submission = { text: string; query: string }

/** What a box asks for: nothing below the minimum; a pasted contact QR is looked up by its 咕咕号. */
function submissionOf(typed: string): Submission | null {
  const text = typed.trim()
  if (!searchable(text)) return null
  // @@@contact-qr-import (#537) - 粘贴一张联系人 QR 的文本时，解析出对方咕咕号再搜，让「加我」QR 不用扫码也能加。
  const qr = parseGuguQrPayload(text)
  return { text, query: qr?.kind === 'contact' ? String(qr.gugu_number) : text }
}

const messageOf = (error: unknown) => String((error as Error)?.message ?? error)

/** The name with the searched text in bold (the RPC matches a substring of the name). */
function Highlighted({ name, text }: { name: string; text: string }) {
  const at = name.toLowerCase().indexOf(text.toLowerCase())
  if (!text || at < 0) return <>{name}</>
  return <>{name.slice(0, at)}<b className="font-semibold">{name.slice(at, at + text.length)}</b>{name.slice(at + text.length)}</>
}

function SkeletonRows() {
  const rows = [['opacity-100', 'w-[38%]'], ['opacity-75', 'w-[30%]'], ['opacity-50', 'w-[44%]']]
  return (
    <div aria-busy="true" data-testid="friend-search-pending" className="mt-3 flex flex-col">
      {rows.map(([fade, width]) => (
        <div key={width} className={cn('flex items-center gap-3 px-2 py-2', fade)}>
          <div className="size-[var(--avatar-sm)] shrink-0 rounded-full bg-[var(--muted)]" />
          <div className="flex flex-1 flex-col gap-2">
            <div className={cn('h-2.5 rounded-full bg-[var(--muted)]', width)} />
            <div className="h-2 w-1/5 rounded-full bg-[var(--muted)]" />
          </div>
        </div>
      ))}
    </div>
  )
}

type Status = 'friend' | 'sent' | null

// ── Search result row ─────────────────────────────────────────────────────────
// 按下「添加」不再弹附言 Dialog:附言在这一行里展开(少一层窗),发出后这一行留在原地,按钮变成「✓ 已发送」。

function ResultRow({
  user, text, status, active, open, note, sending, error, justSent,
  onPick, onOpen, onNote, onCancel, onSend, onAgain,
}: {
  user: ContactUser
  text: string
  status: Status
  active: boolean
  open: boolean
  note: string
  sending: boolean
  error: string | null
  justSent: boolean
  onPick: () => void
  onOpen: () => void
  onNote: (note: string) => void
  onCancel: () => void
  onSend: () => void
  onAgain: () => void
}) {
  const { t } = useTranslation('contacts')
  const agent = user.type === 'agent'
  const right = status === 'friend'
    ? <span className={captionClass}>{t('friendSearch.alreadyFriend')}</span>
    : status === 'sent'
      ? <span data-testid="friend-search-sent" className="inline-flex items-center gap-1.5 whitespace-nowrap text-[length:var(--font-body)] text-[var(--text-secondary)]"><Check size={14} aria-hidden />{t('friendSearch.requestSent')}</span>
      : open ? null
        : <Button variant={active ? 'primary' : 'secondary'} size="sm" data-testid="friend-search-add" onClick={onOpen}>{agent ? t('friendSearch.requestToJoin') : t('friendSearch.add')}</Button>
  return (
    <div data-testid="friend-search-result" data-user-id={user.id} className={cn('rounded-[var(--radius-surface)]', open && 'shadow-[inset_0_0_0_1px_var(--border-color)] pb-3')}>
      <div className="gg-list-row gg-row" data-selected={active && !open ? '' : undefined} onMouseEnter={onPick}>
        <ListRowContent
          leading={<Avatar name={user.display_name} avatarUrl={user.avatar} seed={user.id} size="sm" isAgent={agent} />}
          title={<Highlighted name={user.display_name} text={text} />}
          accessory={agent ? <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('common.agent')}</span> : undefined}
          subtitle={user.gugu_number == null ? t('friendSearch.guguNumberUnassigned') : t('friendSearch.guguNumberValue', { number: user.gugu_number })}
        />
        {right}
      </div>
      {open ? (
        <div data-testid="friend-request-note" className="ml-14 mr-3 mt-1 flex flex-col gap-2">
          <Field.Textarea
            rows={2}
            value={note}
            autoFocus
            maxLength={200}
            disabled={sending}
            aria-label={t('friendSearch.requestTitle')}
            placeholder={t('friendSearch.notePlaceholder')}
            onChange={(event) => onNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Escape') { event.preventDefault(); onCancel() }
              else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSend() }
            }}
          />
          {error ? <div role="alert" data-testid="friend-request-failed" className="text-[length:var(--font-caption)] text-[var(--danger-fg)]">{t('friendSearch.sendFailed', { detail: error })}</div> : null}
          <div className="flex items-center justify-between gap-3">
            <span className={captionClass}>{t('friendSearch.noteHint')}</span>
            <span className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={sending} onClick={onCancel}>{t('common.cancel')}</Button>
              <Button variant="primary" size="sm" disabled={sending} data-testid="friend-request-send" onClick={onSend}>
                {sending ? t('friendSearch.sending') : error ? t('common.retry') : t('friendSearch.send')}
              </Button>
            </span>
          </div>
        </div>
      ) : null}
      {justSent ? (
        <div className={cn(captionClass, 'flex flex-wrap items-center gap-x-3 pb-1 pl-14')}>
          {t('friendSearch.sentHint', { name: user.display_name })}
          <Button variant="ghost" size="sm" data-testid="friend-search-again" onClick={onAgain}>{t('friendSearch.searchAnother')}</Button>
        </div>
      ) : null}
    </div>
  )
}

// ── AddFriendSearch (exported) ────────────────────────────────────────────────

// showHeader: 面板态渲染「添加联系人」头部（+ 移动端 onBack chevron）；弹窗态由 modal 自带头部 → 传 false。
// autoFocus: 挂载即聚焦搜索框（弹窗/点「添加联系人」入口都希望立刻能打字）。
// seed: 扫码得到的咕咕号 → 自动填入并搜索。
// onBack: 离开这一页（面板态的返回 / 弹窗的关闭）。发出申请后**不再**自动离开:结果留在原地给人看见。
export function AddFriendSearch({
  seed,
  autoFocus,
  showHeader,
  onBack,
  mode = 'contact',
}: {
  seed?: { query: string; token: number } | null
  autoFocus?: boolean
  showHeader?: boolean
  onBack?: () => void
  // 「加人」与「加群」共用这一页,但**选哪一档发生在右上角那个加人按钮的菜单里**,
  // ❌ 页内不再放第二个开关(owner:「为什么不用这个按钮变多功能按钮」)。
  mode?: 'contact' | 'group'
}) {
  const { t } = useTranslation('contacts')
  useBackLayer(showHeader ? onBack : undefined) // 面板态(手机整页):安卓返回键 = 左上返回
  const { contacts, sentRequests, sendRequest } = useContactsStore()
  const { user: me } = useAuth()
  const input = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  // 拼写中的输入不算数:只有拼写结束后的文字才进防抖。
  const [composing, setComposing] = useState(false)
  const [settled, setSettled] = useState('')
  const typed = useDebounce(settled, DEBOUNCE_MS)
  const [submitted, setSubmitted] = useState<Submission | null>(null)
  const found = useReplica(userSearch, submitted ? [submitted.query] : null, { keepPrevious: true })
  const fetching = useReplicaFetching(userSearch, submitted ? [submitted.query] : null)
  const slow = useDebounce(fetching, PENDING_SHOW_MS) && fetching
  const [active, setActive] = useState(0)

  const [openId, setOpenId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [justSentId, setJustSentId] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(false)

  useEffect(() => { setSubmitted(submissionOf(typed)) }, [typed])

  // @@@scan-seed (#537-A) - 扫码得到的咕咕号路由到这里：填入搜索框并立即提交这次搜索，命中的人带「添加」按钮。
  useEffect(() => {
    if (!seed) return
    setQuery(seed.query)
    setSettled(seed.query)
    setSubmitted(submissionOf(seed.query))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token])

  const sentIds = new Set(sentRequests.map((r) => r.receiver_id))
  const friendIds = new Set(contacts.map((c) => c.id))
  const statusOf = (u: ContactUser): Status => friendIds.has(u.id) ? 'friend' : sentIds.has(u.id) ? 'sent' : null
  const results = found.state === 'value' && submitted ? found.value : []
  const people = results.filter((u) => u.type !== 'agent')
  const agents = results.filter((u) => u.type === 'agent')
  const ordered = [...people, ...agents]
  const current = Math.min(active, Math.max(0, ordered.length - 1))
  // 框里的字和画着的结果对得上,Enter 才是「加这一行」;否则 Enter 是「现在就搜」。
  const showingTyped = !!submitted && submitted.text === query.trim() && found.state === 'value' && !fetching

  const clearSearch = () => {
    setQuery(''); setSettled(''); setSubmitted(null); setOpenId(null); setJustSentId(null); setActive(0)
    input.current?.focus()
  }
  const change = (value: string) => {
    setQuery(value)
    if (!composing) setSettled(value)
    if (!value.trim()) { setSubmitted(null); setOpenId(null); setJustSentId(null) }
    setActive(0)
  }
  const searchNow = () => {
    const next = submissionOf(query)
    if (next && next.query === submitted?.query) void userSearch.refresh(next.query)
    setSettled(query)
    setSubmitted(next)
  }
  const openNote = (u: ContactUser) => {
    if (statusOf(u)) return
    setOpenId(u.id); setNote(''); setSendError(null); setJustSentId(null)
  }
  const closeNote = () => {
    if (sending) return
    setOpenId(null); setSendError(null)
    input.current?.focus()
  }
  async function submitRequest(target: ContactUser) {
    if (sending) return
    setSending(true)
    setSendError(null)
    try {
      await sendRequest(target.id, note)
      setOpenId(null)
      setNote('')
      setJustSentId(target.id)
    } catch (err) {
      // @@@1505 反 fake success：发送失败（网络 / 重复申请约束等）就地说清，附言保留，按钮变「重试」。
      setSendError(messageOf(err))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && query) { event.preventDefault(); clearSearch(); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (showingTyped && ordered[current]) openNote(ordered[current]!)
      else searchNow()
      return
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && ordered.length > 0) {
      event.preventDefault()
      setActive(Math.max(0, Math.min(ordered.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
    }
  }

  const rowFor = (u: ContactUser) => (
    <ResultRow
      key={u.id}
      user={u}
      text={submitted?.text ?? ''}
      status={statusOf(u)}
      active={ordered[current]?.id === u.id}
      open={openId === u.id}
      note={note}
      sending={sending}
      error={openId === u.id ? sendError : null}
      justSent={justSentId === u.id}
      onPick={() => setActive(ordered.indexOf(u))}
      onOpen={() => openNote(u)}
      onNote={setNote}
      onCancel={closeNote}
      onSend={() => void submitRequest(u)}
      onAgain={clearSearch}
    />
  )

  const myQr = me?.gugu_number != null && me.gugu_number > 0 ? createGuguQrUrl(createContactQrPayload(me.gugu_number)) : null
  const waiting = sentRequests.filter((request) => request.receiver)
  const failure = submitted ? refreshFailure(found) : null

  let body
  if (!submitted) {
    body = (
      <div className="flex flex-col">
        <div className="mt-10">
          <PaneEmptyState
            art={<Illustration name="add-contact" className="w-[132px]" />}
            caption={t('friendSearch.emptyTitle')}
            hint={t('friendSearch.emptyHint')}
            action={myQr ? <>
              <span className={cn(captionClass, 'inline-flex items-center gap-2')} data-testid="friend-search-my-id">
                {t('friendSearch.myGuguId')}<CopyValue value={String(me!.gugu_number)} message={t('common.copiedGuguNumber')} feedback="inline" />
              </span>
              <Button variant="ghost" size="sm" data-testid="friend-search-my-qr" onClick={() => setShowQr(true)}><QrCode size={15} aria-hidden />{t('friendSearch.showMyQr')}</Button>
            </> : undefined}
          />
        </div>
        {waiting.length > 0 ? (
          <section className="mt-8" data-testid="friend-search-waiting">
            <SectionLabel>{t('friendSearch.waitingForReply', { count: waiting.length })}</SectionLabel>
            {waiting.map((request) => (
              <div key={request.id} className="gg-list-row gg-row">
                <ListRowContent
                  leading={<Avatar name={request.receiver!.display_name} avatarUrl={request.receiver!.avatar} seed={request.receiver_id} size="sm" isAgent={request.receiver!.type === 'agent'} />}
                  title={request.receiver!.display_name}
                  subtitle={request.message || t('friendSearch.requestSent')}
                />
              </div>
            ))}
          </section>
        ) : null}
      </div>
    )
  } else if (found.state === 'unknown') {
    body = slow ? <SkeletonRows /> : null
  } else if (failure) {
    body = (
      <div role="alert" data-testid="friend-search-failed" className="mt-4 flex items-center gap-3 rounded-[var(--radius-surface)] border border-[var(--border-color)] p-3 text-[length:var(--font-body)] text-[var(--text-secondary)]">
        <span className="flex-1">{t('friendSearch.searchFailed', { detail: messageOf(failure) })}</span>
        <Button variant="secondary" size="sm" onClick={retryOf(found)}>{t('common.retry')}</Button>
      </div>
    )
  } else if (results.length === 0) {
    body = (
      <div className="mt-10" data-testid="friend-search-empty">
        <PaneEmptyState
          art={<Illustration name="no-match" className="w-[112px]" />}
          caption={t('friendSearch.noResultsFor', { query: submitted.text })}
          hint={t('friendSearch.noResultsHint')}
          action={submitted.text === query.trim() ? <InviteFriendsPreview /> : undefined}
        />
      </div>
    )
  } else {
    body = (
      <div className={cn('flex flex-col transition-opacity duration-[var(--dur-fast)]', fetching && 'opacity-60')}>
        {people.length > 0 ? <><SectionLabel className="!mt-3">{t('panel.contactSectionTitle')} · {people.length}</SectionLabel>{people.map(rowFor)}</> : null}
        {agents.length > 0 ? <><SectionLabel className="!mt-3">{t('panel.agentSectionTitle')} · {agents.length}</SectionLabel>{agents.map(rowFor)}</> : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg-primary)]">
      {showHeader && (
        <div className={headClass}>
          {onBack ? (
            <button className={backButtonClass} aria-label={t('common.back')} onClick={onBack}>
              <BackChevron />
            </button>
          ) : null}
          {mode === 'group' ? t('joinGroup.title') : t('panel.addContact')}
        </div>
      )}

      {mode === 'group' ? <JoinGroupById headless={!showHeader} /> : (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className={cn('mx-auto flex w-full max-w-[560px] flex-col px-4 pb-6', !showHeader && 'pt-3')}>
          <SearchField
            ref={input}
            value={query}
            onChange={(event) => change(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => { setComposing(false); setSettled(event.currentTarget.value) }}
            onKeyDown={onKeyDown}
            placeholder={t('friendSearch.searchPlaceholder')}
            autoFocus={autoFocus}
            clearLabel={t('friendSearch.clearSearch')}
            onClear={clearSearch}
          />
          {body}
        </div>
      </div>
      )}

      {showQr && myQr ? (
        <PersonalSharePreview title={me!.nickname} subtitle={t('friendSearch.qrSubtitle')} qrValue={myQr} onClose={() => setShowQr(false)} />
      ) : null}
    </div>
  )
}
