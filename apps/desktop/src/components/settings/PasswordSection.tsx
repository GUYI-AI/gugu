import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { PASSWORD_FILL_EVENT, takePasswordFill, type PasswordBetaUi, type PasswordField, type PasswordGrant, type PasswordItem, type PasswordSaveDraft, type PasswordSecrets, type PasswordSnapshot, type PasswordUiCommand } from '@gugu/core/shared/passwordBetaProtocol'
import { ChevronRight, Eye, EyeOff, Globe, Plus, Trash } from '@/lib/icons'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { Field } from '../ui/Field'
import { IconButton } from '../ui/IconButton'
import { SearchField } from '../ui/SearchField'
import { RecoveryOffer } from '../password/PasswordRecovery'
import { passwordErrorText } from '../password/passwordModel'

declare global { interface Window { passwordVaultBeta?: PasswordBetaUi } }

/**
 * Settings → 密码. Four screens, laid out after the reference the owner chose (Muse 「安全存储」):
 * list → add/edit → detail (login info, Agent access, delete) → authorized Agents.
 * A credential is key-value: website, account, password, plus any named fields.
 * Access is per credential: listed Agents/projects may read or write; everyone else must ask each time.
 */
type View = { kind: 'list' } | { kind: 'form'; id?: string; request?: { id: string; draft: PasswordSaveDraft } } | { kind: 'detail'; id: string } | { kind: 'grants'; id: string }

const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
const errorText = passwordErrorText
const LEVEL = { read: '可读', write: '可写' } as const
/** Every value column ends in the same trailing slot (eye, remove, or nothing), so inputs and values line up. */
const trailing = (node?: ReactNode) => <span className="flex w-8 shrink-0 items-center justify-center">{node}</span>
const control = (input: ReactNode, end?: ReactNode) => <div className="flex items-center gap-1"><div className="w-[320px]">{input}</div>{trailing(end)}</div>

export function PasswordSection({ actionsHost }: { actionsHost?: () => HTMLElement | null } = {}) {
  const [snapshot, setSnapshot] = useState<PasswordSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>({ kind: 'list' })
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
  if (view.kind === 'form') return <CredentialForm key={view.request?.id ?? view.id ?? 'new'} item={item} request={view.request} {...props} />
  if (view.kind === 'detail' && item) return <CredentialDetail key={item.reference.id} item={item} {...props} />
  if (view.kind === 'grants' && item) return <GrantsPage item={item} {...props} />
  const add = <Button variant="primary" disabled={busy} onClick={() => go({ kind: 'form' })}>添加</Button>
  const slot = actionsHost?.()
  return <SettingsPage data-testid="password-settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsNote>安全存储密码以供你的智能体使用。</SettingsNote>
      {slot ? createPortal(add, slot) : add}
    </div>
    <SettingsGroup title="密码管理" presentation="navigation">
      {snapshot?.items.map(value => <SettingsRow key={value.reference.id} leading={<Globe size={18} aria-hidden="true" />} title={host(value.origin)}
        control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />} onClick={() => go({ kind: 'detail', id: value.reference.id })} />)}
      {snapshot && !snapshot.items.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">还没有保存密码</span>} />}
    </SettingsGroup>
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    <RecoveryOffer snapshot={snapshot} />
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
  useSettingsDetail(editing ? `password-edit:${item.reference.id}` : 'password-add', editing ? host(item.origin) : '添加密码', back)
  const draft = request?.draft
  const [origin, setOrigin] = useState(item?.origin ?? draft?.origin ?? '')
  const [account, setAccount] = useState(draft?.account ?? '')
  const [password, setPassword] = useState(draft?.password ?? '')
  const [shown, setShown] = useState(false)
  // Editing pre-fills field names only; values stay blank, and blank keeps the stored value. An Agent's proposal fills in what it sent.
  const [fields, setFields] = useState<PasswordField[]>(() => {
    const stored = (item?.fields ?? []).map(field => ({ ...field, value: draft?.fields.find(value => value.id === field.id)?.value ?? '' }))
    return [...stored, ...(draft?.fields ?? []).filter(field => !stored.some(value => value.id === field.id))]
  })
  useEffect(() => () => { setPassword(''); setAccount(''); setFields([]) }, [])
  const keep = editing ? '留空不修改' : undefined
  const submit = async () => {
    const result = await run({ type: 'save', origin: origin.trim(), account, password, fields: fields.filter(field => field.name.trim()).map(field => ({ ...field, name: field.name.trim() })), reference: item?.reference, requestId: request?.id })
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
        <SettingsRow title="网址" control={control(<Field.Root><Field.Input required type="url" aria-label="网址" value={origin} readOnly={!!draft} placeholder="https://example.com" onChange={event => setOrigin(event.target.value)} /></Field.Root>)} />
        <SettingsRow title="账号" control={control(<Field.Root><Field.Input required={!editing} aria-label="账号" autoComplete="off" value={account} placeholder={editing ? `${keep} · 当前 ${item.maskedAccount}` : undefined} onChange={event => setAccount(event.target.value)} /></Field.Root>)} />
        <SettingsRow title="密码" control={control(
          <Field.Root><Field.Input required={!editing} aria-label="密码" type={shown ? 'text' : 'password'} autoComplete="new-password" value={password} placeholder={keep} onChange={event => setPassword(event.target.value)} /></Field.Root>,
          <IconButton aria-label={shown ? '隐藏密码' : '显示密码'} onClick={() => setShown(value => !value)}>{shown ? <EyeOff /> : <Eye />}</IconButton>)} />
        {fields.map((field, index) => <SettingsRow key={field.id}
          title={<div className="w-[200px]"><Field.Root><Field.Input aria-label="字段名" value={field.name} placeholder="字段名，如 API Key" onChange={event => setFields(list => list.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} /></Field.Root></div>}
          control={control(
            <Field.Root><Field.Input aria-label={`${field.name || '字段'}的值`} type="password" autoComplete="off" value={field.value} placeholder={keep ?? '值'} onChange={event => setFields(list => list.map((value, at) => at === index ? { ...value, value: event.target.value } : value))} /></Field.Root>,
            <IconButton aria-label="移除字段" onClick={() => setFields(list => list.filter((_, at) => at !== index))}><Trash /></IconButton>)} />)}
        <SettingsRow title={<Button variant="ghost" size="sm" onClick={() => setFields(list => [...list, { id: crypto.randomUUID(), name: '', value: '' }])}><Plus size={14} aria-hidden="true" />添加字段</Button>} />
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
  useSettingsDetail(`password:${item.reference.id}`, host(item.origin), () => go({ kind: 'list' }))
  const [secrets, setSecrets] = useState<PasswordSecrets>()
  const [confirming, setConfirming] = useState(false)
  // Plaintext lives only while this page is open and is dropped when the credential changes.
  useEffect(() => { setSecrets(undefined) }, [item.reference.version])
  const reveal = async () => {
    if (secrets) { setSecrets(undefined); return }
    const reply = await run({ type: 'reveal', reference: item.reference })
    if (reply?.secrets) setSecrets(reply.secrets)
  }
  const eye = <IconButton aria-label={secrets ? '隐藏' : '显示（需要验证本人）'} disabled={busy} onClick={() => { void reveal() }}>{secrets ? <EyeOff /> : <Eye />}</IconButton>
  const hidden = <span className="tracking-widest text-[var(--text-secondary)]">••••••••</span>
  const value = (text: string | undefined, end?: ReactNode) => <div className="flex items-center gap-1"><span className="select-text">{text ?? hidden}</span>{trailing(end)}</div>
  const authorized = item.grants.length
  return <SettingsPage data-testid="password-detail">
    <SettingsGroup>
      <SettingsRow leading={<Globe size={18} aria-hidden="true" />} title={host(item.origin)} control={<Button variant="ghost" size="sm" onClick={() => go({ kind: 'form', id: item.reference.id })}>编辑</Button>} />
    </SettingsGroup>
    <SettingsGroup title="登录信息">
      <SettingsRow title="账号" control={value(secrets?.account ?? item.maskedAccount)} />
      <SettingsRow title="密码" control={value(secrets?.password, eye)} />
      {item.fields.map(field => <SettingsRow key={field.id} title={field.name} control={value(secrets?.fields.find(entry => entry.id === field.id)?.value)} />)}
    </SettingsGroup>
    <SettingsGroup title="智能体权限" presentation="navigation">
      <SettingsRow title="已授权的智能体" description={authorized ? undefined : '未授权的智能体每次使用都要问你'}
        control={<span className="flex items-center gap-1 text-[var(--text-secondary)]">{authorized ? `${authorized} 个` : '无'}<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" /></span>}
        onClick={() => go({ kind: 'grants', id: item.reference.id })} />
    </SettingsGroup>
    <SettingsGroup presentation="danger">
      <SettingsRow title={<span className="text-[var(--danger)]">删除</span>} onClick={() => setConfirming(true)} />
    </SettingsGroup>
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    {confirming && <Sheet onClose={() => setConfirming(false)} desktopWidth="400px" mobileFitContent ariaLabel={`删除 ${host(item.origin)} 的密码`}
      testId="password-delete-dialog" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">删除 {host(item.origin)} 的密码？</div>
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
