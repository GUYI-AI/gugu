import { metadataSeparator } from '@/i18n/format'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { PASSWORD_FILL_EVENT, takePasswordFill, type PasswordBetaUi, type PasswordField, type PasswordGrant, type PasswordItem, type PasswordSaveDraft, type PasswordSecrets, type PasswordSnapshot, type PasswordUiCommand } from '@gugu/core/shared/passwordBetaProtocol'
import { passwordSaveDraft, passwordVault } from '@/lib/passwordBetaNotifications'
import { refreshFailure, useReplica, type Reading, retryOf } from '@/lib/replica'
import { Unknown } from '../ui/Unknown'
import { ChevronRight, Eye, EyeOff, Lock, LockOpen, Plus, Trash, X } from '@/lib/icons'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { Field } from '../ui/Field'
import { IconButton } from '../ui/IconButton'
import { SearchField } from '../ui/SearchField'
import { RecoveryOffer } from '../password/PasswordRecovery'
import { usePasswordCommand } from '../password/passwordModel'
import { PasswordUnlockGate } from '../password/PasswordUnlockGate'

declare global { interface Window { passwordVaultBeta?: PasswordBetaUi } }

/**
 * Settings → 密码. Four screens, laid out after the reference the owner chose (Muse 「安全存储」):
 * list → add/edit → detail (login info, Agent access, delete) → authorized Agents.
 * A credential is key-value: website, account, password, plus any named fields.
 * Access is per credential: listed Agents/projects may read or write; everyone else must ask each time.
 */
type View = { kind: 'list' } | { kind: 'form'; id?: string } | { kind: 'request'; requestId: string } | { kind: 'detail'; id: string } | { kind: 'grants'; id: string }

const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
const title = (item: PasswordItem) => item.name || host(item.origin)
/** A list row's second line: its website when it has a name, its account when you may see it, else what it holds. */
function subtitle(t: TFunction<'settings'>, item: PasswordItem): string {
  const parts = [...(item.name ? [host(item.origin)] : []), ...(item.account ? [item.account] : [])]
  if (parts.length) return parts.join(metadataSeparator())
  return [...(item.maskedAccount ? [t('passwords.account')] : []), ...(item.hasPassword ? [t('passwords.password')] : []), ...item.fields.map(field => field.name)].join(t('passwords.listSeparator'))
}
/** Name, website, account (unless secret) and value names; secret values are never in the snapshot to match. */
function matches(item: PasswordItem, query: string): boolean {
  const text = [item.name, host(item.origin), ...item.sites.map(host), item.account ?? item.maskedAccount, ...item.fields.map(field => field.name),
    ...item.fields.map(field => field.value ?? '')].join('\n').toLowerCase()
  return text.includes(query.trim().toLowerCase())
}
const LEVEL = { read: 'passwords.levelRead', write: 'passwords.levelWrite' } as const
/** A row is the field: the value is typed straight into it, and what you can do to it shows when you point at or edit it. */
const ROW = 'group/row'
const actions = (...nodes: ReactNode[]) => <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-[var(--dur-fast)] group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">{nodes}</span>
const INLINE = 'rounded-[var(--radius-control)] !px-2 !py-1 hover:bg-[var(--hover)] focus:bg-[var(--hover)]'
const control = (input: ReactNode, ...end: ReactNode[]) => <div className="flex w-[400px] items-center gap-1"><div className="min-w-0 flex-1">{input}</div>{actions(...end)}</div>
/** Locked: an Agent sees the name only and 咕咕 fills the value. Unlocked: Agents with access may read it. */
const secretMark = (t: TFunction<'settings'>, label: string, secret: boolean, change: (value: boolean) => void) =>
  <IconButton key="secret" size="sm" aria-label={t(secret ? 'passwords.secretOn' : 'passwords.secretOff', { label })} aria-pressed={secret} onClick={() => change(!secret)}
    title={t(secret ? 'passwords.secretOnHint' : 'passwords.secretOffHint')}>{secret ? <Lock /> : <LockOpen />}</IconButton>

export function PasswordSection({ actionsHost }: { actionsHost?: () => HTMLElement | null } = {}) {
  const vault = useReplica(passwordVault, PASSWORD_BETA_ENABLED ? [] : null)
  const snapshot = vault.state === 'value' ? vault.value : undefined
  const { busy, error, run, clear } = usePasswordCommand()
  if (!PASSWORD_BETA_ENABLED) return null
  return <PasswordUnlockGate sync={snapshot?.sync} busy={busy} error={error} run={run} clearError={clear}>
    <PasswordContent vault={vault} snapshot={snapshot} busy={busy} error={error} run={run} clear={clear} actionsHost={actionsHost} />
  </PasswordUnlockGate>
}

/** Unmounting the credential screens while locked also clears their navigation and draft inputs. */
function PasswordContent({ vault, snapshot, busy, error, run, clear, actionsHost }: Omit<ScreenProps, 'go'> & {
  vault: Reading<PasswordSnapshot>; clear(): void; actionsHost?: () => HTMLElement | null
}) {
  const { t } = useTranslation('settings')
  const [view, setView] = useState<View>({ kind: 'list' })
  const [query, setQuery] = useState('')
  // 「去填写」 from an Agent's request in chat: open the same add/edit form, pre-filled with what the Agent proposed.
  // @@@effect-flow(event) - opens the form an Agent's save request asks for (its id only, once per request); what it proposed is the passwordSaveDraft reading
  useEffect(() => {
    if (!PASSWORD_BETA_ENABLED) return
    const open = () => {
      const requestId = takePasswordFill()
      if (requestId) { clear(); setView({ kind: 'request', requestId }) }
    }
    open()
    window.addEventListener(PASSWORD_FILL_EVENT, open)
    return () => window.removeEventListener(PASSWORD_FILL_EVENT, open)
  }, [clear])
  const item = 'id' in view && view.id ? snapshot?.items.find(value => value.reference.id === view.id) : undefined
  // A credential deleted elsewhere returns to the list instead of showing a stale page.
  useEffect(() => { if ('id' in view && view.id && snapshot && !item) setView({ kind: 'list' }) }, [view, snapshot, item])
  const go = (next: View) => { clear(); setView(next) }

  const props = { snapshot, busy, run, go, error }
  // Asked once, right after the first password is kept (the detail page that follows the save, or any page here).
  const offer = <RecoveryOffer snapshot={snapshot} />
  if (view.kind === 'form') return <><CredentialForm key={view.id ?? 'new'} item={item} {...props} />{offer}</>
  if (view.kind === 'request') return <><RequestedForm key={view.requestId} requestId={view.requestId} {...props} />{offer}</>
  if (view.kind === 'detail' && item) return <><CredentialDetail key={item.reference.id} item={item} {...props} />{offer}</>
  if (view.kind === 'grants' && item && snapshot) return <><GrantsPage {...props} item={item} snapshot={snapshot} />{offer}</>
  const add = <Button variant="primary" disabled={busy} onClick={() => go({ kind: 'form' })}>{t('passwords.add')}</Button>
  const slot = actionsHost?.()
  const listed = snapshot?.items.filter(value => !query.trim() || matches(value, query))
  return <SettingsPage data-testid="password-settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsNote>{t('passwords.intro')}</SettingsNote>
      {slot ? createPortal(add, slot) : add}
    </div>
    {!!snapshot?.items.length && <SearchField aria-label={t('passwords.search')} placeholder={t('passwords.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)}
      clearLabel={t('passwords.clearSearch')} onClear={() => setQuery('')} />}
    <SettingsGroup presentation="navigation">
      {vault.state === 'unknown' && <SettingsRow title={<Unknown className="w-40" />} />}
      {listed?.map(value => <SettingsRow key={value.reference.id} title={title(value)} description={subtitle(t, value)}
        control={<span className="flex items-center gap-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{!!value.grants.length && t('passwords.agentCount', { count: value.grants.length })}<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" /></span>}
        onClick={() => go({ kind: 'detail', id: value.reference.id })} />)}
      {!!snapshot?.items.length && !listed?.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">{t('passwords.noMatches')}</span>} />}
      {snapshot && !snapshot.items.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">{t('passwords.empty')}</span>} />}
    </SettingsGroup>
    {refreshFailure(vault) && <div className="flex items-center gap-2" data-testid="password-vault-failed">
      <SettingsNote tone="danger" role="alert">{refreshFailure(vault)!.message}</SettingsNote>
      <Button variant="secondary" size="sm" onClick={retryOf(vault)}>{t('passwords.retry')}</Button>
    </div>}
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    {offer}
  </SettingsPage>
}

/** The form an Agent's save request opens, with what it proposed (passwordSaveDraft) handed to it once. */
function RequestedForm({ requestId, ...props }: ScreenProps & { requestId: string }) {
  const { t } = useTranslation('settings')
  const draft = useReplica(passwordSaveDraft, [requestId])
  const credentialId = draft.state === 'value' ? draft.value?.credentialId : undefined
  // A request to change a stored credential opens on that credential, once the vault's state is there to find it in.
  if (draft.state === 'value' && draft.value && !(credentialId && !props.snapshot)) {
    const item = credentialId ? props.snapshot?.items.find(value => value.reference.id === credentialId) : undefined
    return <CredentialForm item={item} request={{ id: requestId, draft: draft.value }} {...props} />
  }
  return <RequestWaiting requestId={requestId} go={props.go}>
    {draft.state === 'error' ? <>
      <SettingsNote tone="danger" role="alert">{draft.error.message}</SettingsNote>
      <Button variant="secondary" onClick={retryOf(draft)}>{t('passwords.retry')}</Button>
    </> : draft.state === 'value' && !draft.value ? <SettingsNote>{t('passwords.requestHandled')}</SettingsNote>
      : <Unknown className="h-40 w-full" />}
  </RequestWaiting>
}

function RequestWaiting({ requestId, go, children }: { requestId: string; go(view: View): void; children: ReactNode }) {
  const { t } = useTranslation('settings')
  useSettingsDetail(`password-request:${requestId}`, t('passwords.addTitle'), () => go({ kind: 'list' }))
  return <SettingsPage data-testid="password-request">{children}</SettingsPage>
}

interface ScreenProps {
  snapshot?: PasswordSnapshot; busy: boolean; error: string
  run(command: PasswordUiCommand): Promise<{ ok: true; snapshot: PasswordSnapshot; secrets?: PasswordSecrets; recoveryCode?: string } | undefined>
  go(view: View): void
}

function CredentialForm({ item, request, busy, run, go, error }: ScreenProps & { item?: PasswordItem; request?: { id: string; draft: PasswordSaveDraft } }) {
  const { t } = useTranslation('settings')
  const editing = !!item
  const back = () => go(item ? { kind: 'detail', id: item.reference.id } : { kind: 'list' })
  useSettingsDetail(editing ? `password-edit:${item.reference.id}` : 'password-add', editing ? title(item) : t('passwords.addTitle'), back)
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
    {draft && <SettingsNote>{t(editing ? 'passwords.requestEdit' : 'passwords.requestSave', { agent: draft.agentName })}</SettingsNote>}
    <form className="contents" onSubmit={event => { event.preventDefault(); void submit() }}>
      <SettingsGroup>
        <SettingsRow className={ROW} title={t('passwords.name')} control={control(<Field.Input variant="bare" className={INLINE} aria-label={t('passwords.name')} value={name} placeholder={t('passwords.namePlaceholder')} onChange={event => setName(event.target.value)} />)} />
        <SettingsRow className={ROW} title={t('passwords.website')} control={control(<Field.Input variant="bare" className={INLINE} required type="url" aria-label={t('passwords.website')} value={origin} readOnly={!!draft} placeholder="https://example.com" onChange={event => setOrigin(event.target.value)} />)} />
        {!!sites.length && <SettingsRow title={t('passwords.alsoFills')} control={<div className="flex w-[400px] flex-wrap gap-1 pl-2">
          {sites.map(site => <span key={site} className="group/site flex h-6 items-center rounded-full bg-[var(--hover)] pl-2 pr-1 text-[length:var(--font-caption)]">{host(site)}
            <IconButton size="sm" aria-label={t('passwords.stopFilling', { site: host(site) })} className="!size-4 text-[var(--text-secondary)] opacity-0 hover:text-[var(--fg)] focus-visible:opacity-100 group-hover/site:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => setSites(list => list.filter(value => value !== site))}><X size={11} aria-hidden="true" /></IconButton></span>)}
        </div>} />}
      </SettingsGroup>
      <SettingsGroup>
        {login && <SettingsRow className={ROW} title={t('passwords.account')} control={control(<Field.Input variant="bare" className={INLINE} aria-label={t('passwords.account')} autoComplete="off" type={accountSecret ? 'password' : 'text'} value={account}
          placeholder={editing && accountSecret && item.maskedAccount ? keep : t('passwords.accountPlaceholder')} onChange={event => setAccount(event.target.value)} />,
          secretMark(t, t('passwords.account'), accountSecret, setAccountSecret))} />}
        {login && <SettingsRow className={ROW} title={t('passwords.password')} control={control(
          <Field.Input variant="bare" className={INLINE} aria-label={t('passwords.password')} type={shown ? 'text' : 'password'} autoComplete="new-password" value={password} placeholder={editing && item.hasPassword ? keep : t('passwords.password')} onChange={event => setPassword(event.target.value)} />,
          !!password && <IconButton key="show" size="sm" aria-label={t(shown ? 'passwords.hidePassword' : 'passwords.showPassword')} onClick={() => setShown(value => !value)}>{shown ? <EyeOff /> : <Eye />}</IconButton>)} />}
        {fields.map((field, index) => <SettingsRow key={field.id} className={ROW}
          title={<div className="-ml-2 w-[180px]"><Field.Input variant="bare" className={INLINE} aria-label={t('passwords.fieldName')} value={field.name} placeholder={t('passwords.fieldNamePlaceholder')} onChange={event => setFields(list => list.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} /></div>}
          control={control(
            <Field.Input variant="bare" className={INLINE} aria-label={t('passwords.fieldValue', { name: field.name || t('passwords.thisField') })} type={field.secret === false ? 'text' : 'password'} autoComplete="off" value={field.value} required={missing(field)}
              placeholder={missing(field) ? t('passwords.toFill') : field.secret !== false ? (item?.fields.some(value => value.id === field.id) ? keep : t('passwords.secretValue')) : t('passwords.value')}
              onChange={event => setFields(list => list.map((value, at) => at === index ? { ...value, value: event.target.value } : value))} />,
            secretMark(t, field.name || t('passwords.thisField'), field.secret !== false, value => setFields(list => list.map((entry, at) => at === index ? { ...entry, secret: value } : entry))),
            <IconButton key="remove" size="sm" aria-label={t('passwords.removeField', { name: field.name || t('passwords.thisField') })} onClick={() => setFields(list => list.filter((_, at) => at !== index))}><Trash /></IconButton>)} />)}
        <SettingsRow title={<div className="-ml-2 flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setFields(list => [...list, { id: crypto.randomUUID(), name: '', value: '', secret: true }])}><Plus size={14} aria-hidden="true" />{t('passwords.addField')}</Button>
          {!login && <Button variant="ghost" size="sm" onClick={() => setLogin(true)}><Plus size={14} aria-hidden="true" />{t('passwords.addLogin')}</Button>}
        </div>} />
      </SettingsGroup>
      {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={back}>{t('passwords.cancel')}</Button>
        <Button variant="primary" type="submit" disabled={busy}>{t(editing ? 'passwords.save' : 'passwords.add')}</Button>
      </div>
    </form>
  </SettingsPage>
}

function CredentialDetail({ item, busy, run, go, error }: ScreenProps & { item: PasswordItem }) {
  const { t } = useTranslation('settings')
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
  const eye = <IconButton size="sm" aria-label={t(secrets ? 'passwords.hide' : 'passwords.showVerified')} disabled={busy} onClick={() => { void reveal() }}>{secrets ? <EyeOff /> : <Eye />}</IconButton>
  const hidden = <span className="tracking-widest text-[var(--text-secondary)]">••••••••</span>
  // The eye shows when you point at the row; a value on screen keeps its eye so it can be hidden again.
  const value = (text: string | undefined, secret?: boolean) => <div className="flex items-center gap-1">
    {secret && <span className={secrets ? 'flex' : 'flex opacity-0 transition-opacity duration-[var(--dur-fast)] group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100'}>{eye}</span>}
    <span className="select-text">{text ?? hidden}</span></div>
  /** A secret value's name carries a lock; what the lock means is said where it is set (the edit form). */
  const named = (name: string, secret: boolean) => secret
    ? <span className="flex items-center gap-1">{name}<Lock size={13} aria-label={t('passwords.secret')} className="text-[var(--text-secondary)]" /></span> : name
  const authorized = item.grants.length
  return <SettingsPage data-testid="password-detail">
    <SettingsGroup>
      <SettingsRow title={title(item)}
        description={[...(item.name ? [host(item.origin)] : []), ...item.sites.map(host)].join(metadataSeparator()) || undefined}
        control={<Button variant="ghost" size="sm" onClick={() => go({ kind: 'form', id: item.reference.id })}>{t('passwords.edit')}</Button>} />
    </SettingsGroup>
    <SettingsGroup>
      {(item.account || item.maskedAccount) && <SettingsRow className={ROW} title={named(t('passwords.account'), item.accountSecret)} control={value(item.account ?? secrets?.account ?? item.maskedAccount, item.accountSecret)} />}
      {item.hasPassword && <SettingsRow className={ROW} title={named(t('passwords.password'), true)} control={value(secrets?.password, true)} />}
      {item.fields.map(field => <SettingsRow key={field.id} className={ROW} title={named(field.name, field.secret)}
        control={value(field.value ?? secrets?.fields.find(entry => entry.id === field.id)?.value, field.secret)} />)}
    </SettingsGroup>
    <SettingsGroup presentation="navigation">
      <SettingsRow title={t('passwords.authorizedAgents')} description={t('passwords.othersAsk')}
        control={<span className="flex items-center gap-1 text-[var(--text-secondary)]">{authorized ? t('passwords.authorizedCount', { count: authorized }) : t('passwords.none')}<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" /></span>}
        onClick={() => go({ kind: 'grants', id: item.reference.id })} />
    </SettingsGroup>
    <SettingsGroup presentation="danger">
      <SettingsRow title={<span className="text-[var(--danger)]">{t('passwords.delete')}</span>} onClick={() => setConfirming(true)} />
    </SettingsGroup>
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    {confirming && <Sheet onClose={() => setConfirming(false)} desktopWidth="400px" mobileFitContent ariaLabel={t('passwords.deleteLabel', { name: title(item) })}
      testId="password-delete-dialog" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('passwords.deleteTitle', { name: title(item) })}</div>
        <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">{t('passwords.deleteBody')}</div>
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setConfirming(false)}>{t('passwords.cancel')}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => { void run({ type: 'delete', reference: item.reference }).then(ok => { setConfirming(false); if (ok) go({ kind: 'list' }) }) }}>{t('passwords.delete')}</Button>
        </div>
      </div>
    </Sheet>}
  </SettingsPage>
}

function GrantsPage({ item, snapshot, busy, run, go, error }: ScreenProps & { item: PasswordItem; snapshot: PasswordSnapshot }) {
  const { t } = useTranslation('settings')
  useSettingsDetail(`password-grants:${item.reference.id}`, t('passwords.authorizedAgents'), () => go({ kind: 'detail', id: item.reference.id }))
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const candidates = snapshot.candidates
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
    return value?.kind === 'project' ? t('passwords.allProjectTasks') : value?.project
  }
  const levels = (subject: string, current?: 'read' | 'write') => <div className="flex items-center gap-1" role="radiogroup" aria-label={t('passwords.permission')}>
    {(['read', 'write'] as const).map(level => <Button key={level} variant="option" size="sm" role="radio" aria-checked={current === level} disabled={busy}
      onClick={() => set(subject, level)}>{t(LEVEL[level])}</Button>)}
    {current && <Button variant="ghost" size="sm" disabled={busy} onClick={() => set(subject)}>{t('passwords.revoke')}</Button>}
  </div>
  return <SettingsPage data-testid="password-grants">
    <SearchField aria-label={t('passwords.searchAgents')} placeholder={t('passwords.searchAgentsPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
    <SettingsGroup note={t('passwords.grantsNote')}>
      {granted.map(grant => <SettingsRow key={grant.subject} title={label(grant.subject)?.name ?? t('passwords.removedAgent')} description={describe(grant.subject)} control={levels(grant.subject, grant.level)} />)}
      {!item.grants.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">{t('passwords.noGrants')}</span>} />}
      <SettingsRow title={<Button variant="ghost" size="sm" onClick={() => setAdding(value => !value)}><Plus size={14} aria-hidden="true" />{t('passwords.grantAgent')}</Button>} />
    </SettingsGroup>
    {adding && <SettingsGroup title={t('passwords.chooseSubject')}>
      {available.map(value => <SettingsRow key={value.subject} title={value.name} description={value.kind === 'project' ? t('passwords.allProjectTasks') : value.project} control={levels(value.subject)} />)}
      {!available.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">{t('passwords.noCandidates')}</span>} />}
    </SettingsGroup>}
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
  </SettingsPage>
}
