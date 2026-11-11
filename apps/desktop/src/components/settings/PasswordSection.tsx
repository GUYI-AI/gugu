import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { PASSWORD_FILL_EVENT, takePasswordFill, type PasswordBetaUi, type PasswordField, type PasswordGrant, type PasswordItem, type PasswordSaveDraft, type PasswordSecrets, type PasswordSnapshot, type PasswordUiCommand } from '@gugu/core/shared/passwordBetaProtocol'
import { ChevronRight, Eye, EyeOff, Lock, LockOpen, Plus, Trash, X } from '@/lib/icons'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { Field } from '../ui/Field'
import { IconButton } from '../ui/IconButton'
import { SearchField } from '../ui/SearchField'
import { RecoveryOffer } from '../password/PasswordRecovery'
import { passwordErrorText, waitingToJoin } from '../password/passwordModel'

declare global { interface Window { passwordVaultBeta?: PasswordBetaUi } }

/**
 * Settings → 密码. Four screens, laid out after the reference the owner chose (Muse 「安全存储」):
 * list → add/edit → detail (login info, Agent access, delete) → authorized Agents.
 * A credential is key-value: website, account, password, plus any named fields.
 * Access is per credential: listed Agents/projects may read or write; everyone else must ask each time.
 */
type View = { kind: 'list' } | { kind: 'form'; id?: string; request?: { id: string; draft: PasswordSaveDraft } } | { kind: 'detail'; id: string } | { kind: 'grants'; id: string }

const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
const title = (item: PasswordItem) => item.name || host(item.origin)
/** A list row's second line: its website when it has a name, its account when you may see it, else what it holds. */
function subtitle(item: PasswordItem): string {
  const parts = [...(item.name ? [host(item.origin)] : []), ...(item.account ? [item.account] : [])]
  if (parts.length) return parts.join(' · ')
  return [...(item.maskedAccount ? ['账号'] : []), ...(item.hasPassword ? ['密码'] : []), ...item.fields.map(field => field.name)].join('、')
}
/** Name, website, account (unless secret) and value names; secret values are never in the snapshot to match. */
function matches(item: PasswordItem, query: string): boolean {
  const text = [item.name, host(item.origin), ...item.sites.map(host), item.account ?? item.maskedAccount, ...item.fields.map(field => field.name),
    ...item.fields.map(field => field.value ?? '')].join('\n').toLowerCase()
  return text.includes(query.trim().toLowerCase())
}
const errorText = passwordErrorText
const LEVEL = { read: '可读', write: '可写' } as const
/** A row is the field: the value is typed straight into it, and what you can do to it shows when you point at or edit it. */
const ROW = 'group/row'
const actions = (...nodes: ReactNode[]) => <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-[var(--dur-fast)] group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">{nodes}</span>
const INLINE = 'rounded-[var(--radius-control)] !px-2 !py-1 hover:bg-[var(--hover)] focus:bg-[var(--hover)]'
const control = (input: ReactNode, ...end: ReactNode[]) => <div className="flex w-[400px] items-center gap-1"><div className="min-w-0 flex-1">{input}</div>{actions(...end)}</div>
/** Locked: an Agent sees the name only and 咕咕 fills the value. Unlocked: Agents with access may read it. */
const secretMark = (label: string, secret: boolean, change: (value: boolean) => void) =>
  <IconButton key="secret" size="sm" aria-label={`${label}${secret ? '保密' : '不保密'}`} aria-pressed={secret} onClick={() => change(!secret)}
    title={secret ? '保密：智能体看不到值，只能由咕咕代填。点一下改为不保密' : '不保密：授权过的智能体能读到。点一下改为保密'}>{secret ? <Lock /> : <LockOpen />}</IconButton>

export function PasswordSection({ actionsHost }: { actionsHost?: () => HTMLElement | null } = {}) {
  const [snapshot, setSnapshot] = useState<PasswordSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [query, setQuery] = useState('')
  const invoke = useCallback(async (command: PasswordUiCommand) => {
    const reply = await window.passwordVaultBeta?.invoke(command)
    if (!reply?.ok) { setError(errorText(reply?.code ?? '')); return undefined }
    setSnapshot(reply.snapshot); setError('')
    return reply
  }, [])
  const run = useCallback(async (command: PasswordUiCommand) => {
    setBusy(true)
    try { return await invoke(command) } catch { setError(errorText('')); return undefined } finally { setBusy(false) }
  }, [invoke])
  useEffect(() => {
    if (!PASSWORD_BETA_ENABLED) return
    void invoke({ type: 'snapshot' })
    return window.passwordVaultBeta?.subscribe(() => { void invoke({ type: 'snapshot' }) })
  }, [invoke])
  // 「去填写」 from an Agent's request in chat: open the same add/edit form, pre-filled with what the Agent proposed.
  useEffect(() => {
    if (!PASSWORD_BETA_ENABLED) return
    const open = () => {
      const requestId = takePasswordFill()
      if (requestId) void invoke({ type: 'save-draft', requestId }).then(reply => {
        if (reply?.draft) { setError(''); setView({ kind: 'form', id: reply.draft.credentialId, request: { id: requestId, draft: reply.draft } }) }
      })
    }
    open()
    window.addEventListener(PASSWORD_FILL_EVENT, open)
    return () => window.removeEventListener(PASSWORD_FILL_EVENT, open)
  }, [invoke])
  const item = 'id' in view && view.id ? snapshot?.items.find(value => value.reference.id === view.id) : undefined
  // A credential deleted elsewhere returns to the list instead of showing a stale page.
  useEffect(() => { if ('id' in view && view.id && snapshot && !item) setView({ kind: 'list' }) }, [view, snapshot, item])
  const go = (next: View) => { setError(''); setView(next) }
  if (!PASSWORD_BETA_ENABLED) return null

  const props = { snapshot, busy, run, go, error }
  // Asked once, right after the first password is kept (the detail page that follows the save, or any page here).
  const offer = <RecoveryOffer snapshot={snapshot} />
  if (view.kind === 'form') return <><CredentialForm key={view.request?.id ?? view.id ?? 'new'} item={item} request={view.request} {...props} />{offer}</>
  if (view.kind === 'detail' && item) return <><CredentialDetail key={item.reference.id} item={item} {...props} />{offer}</>
  if (view.kind === 'grants' && item) return <><GrantsPage item={item} {...props} />{offer}</>
  const add = <Button variant="primary" disabled={busy} onClick={() => go({ kind: 'form' })}>添加</Button>
  const slot = actionsHost?.()
  const listed = snapshot?.items.filter(value => !query.trim() || matches(value, query))
  return <SettingsPage data-testid="password-settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsNote>安全存储密码以供你的智能体使用。</SettingsNote>
      {slot ? createPortal(add, slot) : add}
    </div>
    {!!snapshot?.items.length && <SearchField aria-label="搜索密码" placeholder="搜索名称、网站或账号" value={query} onChange={event => setQuery(event.target.value)}
      clearLabel="清除搜索" onClear={() => setQuery('')} />}
    <SettingsGroup presentation="navigation">
      {listed?.map(value => <SettingsRow key={value.reference.id} title={title(value)} description={subtitle(value)}
        control={<span className="flex items-center gap-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{!!value.grants.length && `${value.grants.length} 个智能体`}<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" /></span>}
        onClick={() => go({ kind: 'detail', id: value.reference.id })} />)}
      {!!snapshot?.items.length && !listed?.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">没有匹配的密码</span>} />}
      {snapshot && !snapshot.items.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">{waitingToJoin(snapshot.sync) ? '在另一台设备上允许这台电脑后，你的密码会出现在这里' : '还没有保存密码'}</span>} />}
    </SettingsGroup>
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    {offer}
  </SettingsPage>
}

interface ScreenProps {
  snapshot?: PasswordSnapshot; busy: boolean; error: string
  run(command: PasswordUiCommand): Promise<{ ok: true; snapshot: PasswordSnapshot; secrets?: PasswordSecrets; recoveryCode?: string } | undefined>
  go(view: View): void
}

function CredentialForm({ item, request, busy, run, go, error }: ScreenProps & { item?: PasswordItem; request?: { id: string; draft: PasswordSaveDraft } }) {
  const editing = !!item
  const back = () => go(item ? { kind: 'detail', id: item.reference.id } : { kind: 'list' })
  useSettingsDetail(editing ? `password-edit:${item.reference.id}` : 'password-add', editing ? title(item) : '添加密码', back)
  const draft = request?.draft
  const [origin, setOrigin] = useState(item?.origin ?? draft?.origin ?? '')
  const [name, setName] = useState(draft?.name ?? item?.name ?? '')
  // A non-secret account is not secret from the person either: editing starts from it.
  const [account, setAccount] = useState(draft?.account || item?.account || '')
  const [accountSecret, setAccountSecret] = useState(draft?.accountSecret ?? item?.accountSecret ?? false)
  const [password, setPassword] = useState(draft?.password ?? '')
  // Other websites it may be filled into: added when the person allows one on a request card, removed here.
  const [sites, setSites] = useState<string[]>(item?.sites ?? [])
  const [shown, setShown] = useState(false)
  // A credential without a login (an API key) does not carry two empty rows; they come back on request.
  const [login, setLogin] = useState(!item || !!item.maskedAccount || !!item.account || item.hasPassword || !!draft?.account || !!draft?.password)
  // Editing pre-fills names and non-secret values; secret values stay blank, and blank keeps the stored value. An
  // Agent's proposal fills in what it sent, with the secret marks it proposed (the person decides).
  const [fields, setFields] = useState<PasswordField[]>(() => {
    const stored = (item?.fields ?? []).map(field => {
      const proposed = draft?.fields.find(value => value.id === field.id)
      return { id: field.id, name: field.name, value: proposed?.value || field.value || '', secret: proposed?.secret ?? field.secret }
    })
    return [...stored, ...(draft?.fields ?? []).filter(field => !stored.some(value => value.id === field.id)).map(field => ({ ...field, secret: field.secret ?? true }))]
  })
  // New values the Agent left for the person to fill in.
  const missing = (field: PasswordField) => !!draft && !field.value && !item?.fields.some(value => value.id === field.id)
  useEffect(() => () => { setPassword(''); setAccount(''); setFields([]) }, [])
  const keep = editing ? '••••••••' : undefined
  const submit = async () => {
    const result = await run({ type: 'save', origin: origin.trim(), name: name.trim(), account, accountSecret, password,
      fields: fields.filter(field => field.name.trim()).map(field => ({ ...field, name: field.name.trim(), secret: field.secret ?? true })), sites, reference: item?.reference, requestId: request?.id })
    setPassword('')
    if (result) {
      const saved = editing ? item : result.snapshot.items.find(value => value.origin === new URL(origin.trim()).origin)
      go(saved ? { kind: 'detail', id: saved.reference.id } : { kind: 'list' })
    }
  }
  return <SettingsPage data-testid="password-form">
    {draft && <SettingsNote>{draft.agentName} 请你{editing ? '修改' : '保存'}这条密码。它填好的部分已经放进来了，核对或补全后点{editing ? '「保存」' : '「添加」'}。</SettingsNote>}
    <form className="contents" onSubmit={event => { event.preventDefault(); void submit() }}>
      <SettingsGroup>
        <SettingsRow className={ROW} title="名称" control={control(<Field.Input variant="bare" className={INLINE} aria-label="名称" value={name} placeholder="可选，如「公司 GitHub」" onChange={event => setName(event.target.value)} />)} />
        <SettingsRow className={ROW} title="网址" control={control(<Field.Input variant="bare" className={INLINE} required type="url" aria-label="网址" value={origin} readOnly={!!draft} placeholder="https://example.com" onChange={event => setOrigin(event.target.value)} />)} />
        {!!sites.length && <SettingsRow title="也可填到" control={<div className="flex w-[400px] flex-wrap gap-1 pl-2">
          {sites.map(site => <span key={site} className="group/site flex h-6 items-center rounded-full bg-[var(--hover)] pl-2 pr-1 text-[length:var(--font-caption)]">{host(site)}
            <IconButton size="sm" aria-label={`不再填到 ${host(site)}`} className="!size-4 text-[var(--text-secondary)] opacity-0 hover:text-[var(--fg)] focus-visible:opacity-100 group-hover/site:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => setSites(list => list.filter(value => value !== site))}><X size={11} aria-hidden="true" /></IconButton></span>)}
        </div>} />}
      </SettingsGroup>
      <SettingsGroup>
        {login && <SettingsRow className={ROW} title="账号" control={control(<Field.Input variant="bare" className={INLINE} aria-label="账号" autoComplete="off" type={accountSecret ? 'password' : 'text'} value={account}
          placeholder={editing && accountSecret && item.maskedAccount ? keep : '邮箱或用户名'} onChange={event => setAccount(event.target.value)} />,
          secretMark('账号', accountSecret, setAccountSecret))} />}
        {login && <SettingsRow className={ROW} title="密码" control={control(
          <Field.Input variant="bare" className={INLINE} aria-label="密码" type={shown ? 'text' : 'password'} autoComplete="new-password" value={password} placeholder={editing && item.hasPassword ? keep : '密码'} onChange={event => setPassword(event.target.value)} />,
          !!password && <IconButton key="show" size="sm" aria-label={shown ? '隐藏密码' : '显示密码'} onClick={() => setShown(value => !value)}>{shown ? <EyeOff /> : <Eye />}</IconButton>)} />}
        {fields.map((field, index) => <SettingsRow key={field.id} className={ROW}
          title={<div className="-ml-2 w-[180px]"><Field.Input variant="bare" className={INLINE} aria-label="名字" value={field.name} placeholder="名字，如 API Key" onChange={event => setFields(list => list.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} /></div>}
          control={control(
            <Field.Input variant="bare" className={INLINE} aria-label={`${field.name || '这一项'}的值`} type={field.secret === false ? 'text' : 'password'} autoComplete="off" value={field.value} required={missing(field)}
              placeholder={missing(field) ? '待你填写' : field.secret !== false ? (item?.fields.some(value => value.id === field.id) ? keep : '保密的值') : '值'}
              onChange={event => setFields(list => list.map((value, at) => at === index ? { ...value, value: event.target.value } : value))} />,
            secretMark(field.name || '这一项', field.secret !== false, value => setFields(list => list.map((entry, at) => at === index ? { ...entry, secret: value } : entry))),
            <IconButton key="remove" size="sm" aria-label={`移除${field.name || '这一项'}`} onClick={() => setFields(list => list.filter((_, at) => at !== index))}><Trash /></IconButton>)} />)}
        <SettingsRow title={<div className="-ml-2 flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setFields(list => [...list, { id: crypto.randomUUID(), name: '', value: '', secret: true }])}><Plus size={14} aria-hidden="true" />添加一项</Button>
          {!login && <Button variant="ghost" size="sm" onClick={() => setLogin(true)}><Plus size={14} aria-hidden="true" />账号和密码</Button>}
        </div>} />
      </SettingsGroup>
      {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={back}>取消</Button>
        <Button variant="primary" type="submit" disabled={busy}>{editing ? '保存' : '添加'}</Button>
      </div>
    </form>
  </SettingsPage>
}

function CredentialDetail({ item, busy, run, go, error }: ScreenProps & { item: PasswordItem }) {
  useSettingsDetail(`password:${item.reference.id}`, title(item), () => go({ kind: 'list' }))
  const [secrets, setSecrets] = useState<PasswordSecrets>()
  const [confirming, setConfirming] = useState(false)
  // Plaintext lives only while this page is open and is dropped when the credential changes.
  useEffect(() => { setSecrets(undefined) }, [item.reference.version])
  const reveal = async () => {
    if (secrets) { setSecrets(undefined); return }
    const reply = await run({ type: 'reveal', reference: item.reference })
    if (reply?.secrets) setSecrets(reply.secrets)
  }
  const eye = <IconButton size="sm" aria-label={secrets ? '隐藏' : '显示（需要验证本人）'} disabled={busy} onClick={() => { void reveal() }}>{secrets ? <EyeOff /> : <Eye />}</IconButton>
  const hidden = <span className="tracking-widest text-[var(--text-secondary)]">••••••••</span>
  // The eye shows when you point at the row; a value on screen keeps its eye so it can be hidden again.
  const value = (text: string | undefined, secret?: boolean) => <div className="flex items-center gap-1">
    {secret && <span className={secrets ? 'flex' : 'flex opacity-0 transition-opacity duration-[var(--dur-fast)] group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100'}>{eye}</span>}
    <span className="select-text">{text ?? hidden}</span></div>
  /** A secret value's name carries a lock; what the lock means is said where it is set (the edit form). */
  const named = (name: string, secret: boolean) => secret
    ? <span className="flex items-center gap-1">{name}<Lock size={13} aria-label="保密" className="text-[var(--text-secondary)]" /></span> : name
  const authorized = item.grants.length
  return <SettingsPage data-testid="password-detail">
    <SettingsGroup>
      <SettingsRow title={title(item)}
        description={[...(item.name ? [host(item.origin)] : []), ...item.sites.map(host)].join(' · ') || undefined}
        control={<Button variant="ghost" size="sm" onClick={() => go({ kind: 'form', id: item.reference.id })}>编辑</Button>} />
    </SettingsGroup>
    <SettingsGroup>
      {(item.account || item.maskedAccount) && <SettingsRow className={ROW} title={named('账号', item.accountSecret)} control={value(item.account ?? secrets?.account ?? item.maskedAccount, item.accountSecret)} />}
      {item.hasPassword && <SettingsRow className={ROW} title={named('密码', true)} control={value(secrets?.password, true)} />}
      {item.fields.map(field => <SettingsRow key={field.id} className={ROW} title={named(field.name, field.secret)}
        control={value(field.value ?? secrets?.fields.find(entry => entry.id === field.id)?.value, field.secret)} />)}
    </SettingsGroup>
    <SettingsGroup presentation="navigation">
      <SettingsRow title="已授权的智能体" description="其他智能体每次用都要你允许"
        control={<span className="flex items-center gap-1 text-[var(--text-secondary)]">{authorized ? `${authorized} 个` : '无'}<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" /></span>}
        onClick={() => go({ kind: 'grants', id: item.reference.id })} />
    </SettingsGroup>
    <SettingsGroup presentation="danger">
      <SettingsRow title={<span className="text-[var(--danger)]">删除</span>} onClick={() => setConfirming(true)} />
    </SettingsGroup>
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    {confirming && <Sheet onClose={() => setConfirming(false)} desktopWidth="400px" mobileFitContent ariaLabel={`删除 ${title(item)} 的密码`}
      testId="password-delete-dialog" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">删除 {title(item)} 的密码？</div>
        <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">删除后智能体不能再用它登录。网站上的密码不受影响。</div>
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setConfirming(false)}>取消</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => { void run({ type: 'delete', reference: item.reference }).then(ok => { setConfirming(false); if (ok) go({ kind: 'list' }) }) }}>删除</Button>
        </div>
      </div>
    </Sheet>}
  </SettingsPage>
}

function GrantsPage({ item, snapshot, busy, run, go, error }: ScreenProps & { item: PasswordItem }) {
  useSettingsDetail(`password-grants:${item.reference.id}`, '已授权的智能体', () => go({ kind: 'detail', id: item.reference.id }))
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const candidates = snapshot?.candidates ?? []
  const label = (subject: string) => candidates.find(value => value.subject === subject)
  const save = (grants: PasswordGrant[]) => { void run({ type: 'grants', reference: item.reference, grants }) }
  const set = (subject: string, level?: 'read' | 'write') => {
    if (!item.grants.some(grant => grant.subject === subject)) setAdding(false)
    save(level ? [...item.grants.filter(grant => grant.subject !== subject), { subject, level }] : item.grants.filter(grant => grant.subject !== subject))
  }
  const match = (name: string) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase())
  const granted = item.grants.filter(grant => match(label(grant.subject)?.name ?? ''))
  const available = useMemo(() => candidates.filter(value => !item.grants.some(grant => grant.subject === value.subject) && match(value.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- match reads query
    [candidates, item.grants, query])
  const describe = (subject: string) => {
    const value = label(subject)
    return value?.kind === 'project' ? '项目里的所有任务' : value?.project
  }
  const levels = (subject: string, current?: 'read' | 'write') => <div className="flex items-center gap-1" role="radiogroup" aria-label="权限">
    {(['read', 'write'] as const).map(level => <Button key={level} variant="option" size="sm" role="radio" aria-checked={current === level} disabled={busy}
      onClick={() => set(subject, level)}>{LEVEL[level]}</Button>)}
    {current && <Button variant="ghost" size="sm" disabled={busy} onClick={() => set(subject)}>取消授权</Button>}
  </div>
  return <SettingsPage data-testid="password-grants">
    <SearchField aria-label="搜索智能体" placeholder="搜索智能体或项目" value={query} onChange={event => setQuery(event.target.value)} />
    <SettingsGroup note="不在名单里的智能体，每次使用都要你在私聊里允许。">
      {granted.map(grant => <SettingsRow key={grant.subject} title={label(grant.subject)?.name ?? '已不在的智能体'} description={describe(grant.subject)} control={levels(grant.subject, grant.level)} />)}
      {!item.grants.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">还没有授权</span>} />}
      <SettingsRow title={<Button variant="ghost" size="sm" onClick={() => setAdding(value => !value)}><Plus size={14} aria-hidden="true" />授权智能体</Button>} />
    </SettingsGroup>
    {adding && <SettingsGroup title="选择智能体或项目">
      {available.map(value => <SettingsRow key={value.subject} title={value.name} description={value.kind === 'project' ? '项目里的所有任务' : value.project} control={levels(value.subject)} />)}
      {!available.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">没有可选的</span>} />}
    </SettingsGroup>}
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
  </SettingsPage>
}
