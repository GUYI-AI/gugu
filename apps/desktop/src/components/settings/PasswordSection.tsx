import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { PASSWORD_FILL_EVENT, takePasswordFill, type PasswordBetaUi, type PasswordField, type PasswordGrant, type PasswordItem, type PasswordSaveDraft, type PasswordSecrets, type PasswordSnapshot, type PasswordSyncDevice, type PasswordSyncRequest, type PasswordSyncView, type PasswordUiCommand } from '@gugu/core/shared/passwordBetaProtocol'
import { ChevronRight, Eye, EyeOff, Globe, Plus, Trash } from '@/lib/icons'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { Field } from '../ui/Field'
import { IconButton } from '../ui/IconButton'
import { SearchField } from '../ui/SearchField'

declare global { interface Window { passwordVaultBeta?: PasswordBetaUi } }

/**
 * Settings → 密码. Four screens, laid out after the reference the owner chose (Muse 「安全存储」):
 * list → add/edit → detail (login info, Agent access, delete) → authorized Agents.
 * A credential is key-value: website, account, password, plus any named fields.
 * Access is per credential: listed Agents/projects may read or write; everyone else must ask each time.
 */
type View = { kind: 'list' } | { kind: 'form'; id?: string; request?: { id: string; draft: PasswordSaveDraft } } | { kind: 'detail'; id: string } | { kind: 'grants'; id: string }

const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
const errorText = (code: string) => code === 'CANNOT_UNLOCK' ? '没有通过本人验证。'
  : code === 'INVALID_INPUT' ? '请填写 https 网址、账号和密码；字段名不能重复。'
    : code === 'STALE_REFERENCE' ? '这条密码刚被改过，请返回后重试。'
    : code === 'RECOVERY_INVALID' ? '恢复码不对，请核对后重输。'
      : '暂时无法完成，请稍后重试。'
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
    {snapshot?.sync && <SyncStatus sync={snapshot.sync} busy={busy} run={run} error={error} />}
    <SettingsGroup title="密码管理" presentation="navigation">
      {snapshot?.items.map(value => <SettingsRow key={value.reference.id} leading={<Globe size={18} aria-hidden="true" />} title={host(value.origin)}
        control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />} onClick={() => go({ kind: 'detail', id: value.reference.id })} />)}
      {snapshot && !snapshot.items.length && <SettingsRow title={<span className="text-[var(--text-secondary)]">还没有保存密码</span>} />}
    </SettingsGroup>
    {snapshot?.sync?.state === 'ready' && <SyncDevices devices={snapshot.sync.devices} recovery={snapshot.sync.recovery} busy={busy} run={run} error={error} />}
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
  </SettingsPage>
}

/** The 6 digits both devices show, grouped 3 + 3 so they are easy to compare aloud. */
const Code = ({ value }: { value: string }) => <span className="font-mono text-[length:var(--font-title)] font-semibold tracking-[0.2em] text-[var(--fg)]" aria-label={`验证码 ${value.split('').join(' ')}`}>
  {value.slice(0, 3)} {value.slice(3)}</span>
type SyncProps = { busy: boolean; run: ScreenProps['run']; error: string }
/** Cross-device sync (#2481): what this device is waiting for, or what another device asks of it. */
function SyncStatus({ sync, busy, run, error }: SyncProps & { sync: PasswordSyncView }) {
  const [entering, setEntering] = useState(false)
  const [shown, setShown] = useState<string>()
  const recover = sync.state !== 'ready' && sync.state !== 'off' && sync.recovery
    && <SettingsRow title="用恢复码恢复" description="另一台设备都不在了，就在这里输入恢复码。"
      control={<Button size="sm" disabled={busy} onClick={() => setEntering(true)}>输入恢复码</Button>} />
  const create = async () => { const reply = await run({ type: 'sync-recovery-create' }); if (reply?.recoveryCode) setShown(reply.recoveryCode) }
  const body = sync.state === 'joining' ? <SettingsGroup title="同步到这台设备">
    {sync.code
      ? <SettingsRow title="核对验证码" description="和另一台设备上的数字一样，再在那台设备上点「允许」。" control={<Code value={sync.code} />} />
      : <SettingsRow title="等待另一台设备允许" description="在已经能用这些密码的设备上，打开 设置 → 密码，允许这台设备。" />}
    {recover}
  </SettingsGroup>
    : sync.state === 'blocked' ? <SettingsGroup title="同步到这台设备">
      <SettingsRow title="这台设备的同步钥匙已丢失" description="在另一台设备的 设置 → 密码 里移除这台设备，这里会重新申请。" />
      {recover}
    </SettingsGroup>
      : sync.state === 'ready' ? <>
        {sync.recovery === 'ask' && <SettingsGroup title="设置恢复码">
          <SettingsRow title="生成恢复码" description="所有设备都丢了时，在新设备上登录并输入它，就能找回这些密码。"
            control={<div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => { void run({ type: 'sync-recovery-skip' }) }}>跳过</Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => { void create() }}>生成</Button></div>} />
        </SettingsGroup>}
        {!!sync.requests.length && <SettingsGroup title="新设备请求使用你的密码">
          {sync.requests.map(request => <SyncRequestRow key={request.deviceId} request={request} busy={busy} run={run} error={error} />)}
        </SettingsGroup>}
      </> : null
  return <>
    {body}
    {entering && <RecoverSheet busy={busy} error={error} onClose={() => setEntering(false)}
      onSubmit={async code => { const reply = await run({ type: 'sync-recover', code }); if (reply?.recoveryCode) { setEntering(false); setShown(reply.recoveryCode) } }} />}
    {shown && <RecoveryCodeSheet code={shown} fresh onClose={() => setShown(undefined)} />}
  </>
}
function SyncRequestRow({ request, busy, run }: SyncProps & { request: PasswordSyncRequest }) {
  const reject = <Button size="sm" disabled={busy} onClick={() => { void run({ type: 'sync-reject', deviceId: request.deviceId }) }}>拒绝</Button>
  const name = request.label || '未命名设备'
  if (request.stage === 'new') return <SettingsRow title={name} description="打开后两台设备会显示同一串数字。"
    control={<div className="flex gap-2">{reject}<Button size="sm" variant="primary" disabled={busy} onClick={() => { void run({ type: 'sync-open', deviceId: request.deviceId }) }}>打开</Button></div>} />
  if (request.stage === 'compare' && request.code) return <SettingsRow title={name} description="那台设备上显示的也是这串数字，才点「允许」。"
    control={<div className="flex items-center gap-3"><Code value={request.code} />{reject}
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void run({ type: 'sync-approve', deviceId: request.deviceId }) }}>允许</Button></div>} />
  const description = request.stage === 'waiting' ? '等那台设备显示验证码…'
    : request.stage === 'mismatch' ? '那台设备的验证码对不上，不能允许。'
      : '已在别处打开。拒绝后那台设备会重新申请。'
  return <SettingsRow title={name} description={description} control={reject} />
}
/** A small confirm sheet in the same shape as the credential delete confirm. */
function Confirm({ title, body, action, busy, onConfirm, onClose, testId }: { title: string; body: string; action: string; busy: boolean; onConfirm(): void; onClose(): void; testId: string }) {
  return <Sheet onClose={onClose} desktopWidth="400px" mobileFitContent ariaLabel={title} testId={testId} zIndex="var(--z-settings-modal)">
    <div className="flex flex-col gap-3 p-[18px]">
      <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{title}</div>
      <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">{body}</div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>{action}</Button>
      </div>
    </div>
  </Sheet>
}
/** Shown once, right after the code is made. Where to keep it is said here, the only place it matters. */
function RecoveryCodeSheet({ code, fresh, onClose }: { code: string; fresh?: boolean; onClose(): void }) {
  const [copied, setCopied] = useState(false)
  return <Sheet onClose={onClose} desktopWidth="440px" mobileFitContent ariaLabel="恢复码" testId="password-recovery-code" zIndex="var(--z-settings-modal)">
    <div className="flex flex-col gap-3 p-[18px]">
      <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{fresh ? '新的恢复码' : '恢复码'}</div>
      <div className="select-text rounded-[var(--radius-control)] bg-[var(--muted)] px-4 py-3 text-center font-mono text-[length:var(--font-title)] font-semibold tracking-[0.08em] text-[var(--fg)]">{code}</div>
      <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">
        抄在纸上或打印出来，放在只有你拿得到的地方。所有设备都丢了时，在新设备上登录并输入它，就能找回密码。{fresh ? '之前的恢复码已经失效。' : ''}
      </div>
      <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">
        别存进邮箱或网盘：有人同时拿到它和你的邮箱，就能读到你所有密码。关掉后不能再查看。
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true)) }}>{copied ? '已复制' : '复制'}</Button>
        <Button size="sm" variant="primary" onClick={onClose}>我已保存</Button>
      </div>
    </div>
  </Sheet>
}
function RecoverSheet({ busy, error, onSubmit, onClose }: { busy: boolean; error: string; onSubmit(code: string): Promise<void>; onClose(): void }) {
  const [code, setCode] = useState('')
  useEffect(() => () => setCode(''), [])
  return <Sheet onClose={onClose} desktopWidth="440px" mobileFitContent ariaLabel="用恢复码恢复" testId="password-recover" zIndex="var(--z-settings-modal)">
    <form className="flex flex-col gap-3 p-[18px]" onSubmit={event => { event.preventDefault(); void onSubmit(code) }}>
      <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">用恢复码恢复</div>
      <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">恢复后这台设备就能用你的密码。这个恢复码随即失效，会给你一个新的。</div>
      <Field.Root><Field.Input required aria-label="恢复码" autoComplete="off" spellCheck={false} className="font-mono" value={code}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" onChange={event => setCode(event.target.value)} /></Field.Root>
      {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || !code.trim()}>恢复</Button>
      </div>
    </form>
  </Sheet>
}
function SyncDevices({ devices, recovery, busy, run }: SyncProps & { devices: PasswordSyncDevice[]; recovery: 'set' | 'unset' | 'ask' }) {
  const [removing, setRemoving] = useState<PasswordSyncDevice>()
  const [asking, setAsking] = useState<'regenerate' | 'drop'>()
  const [shown, setShown] = useState<{ code: string; fresh: boolean }>()
  const create = async (fresh: boolean) => { const reply = await run({ type: 'sync-recovery-create' }); setAsking(undefined); if (reply?.recoveryCode) setShown({ code: reply.recoveryCode, fresh }) }
  return <>
    <SettingsGroup title="同步的设备" note="这些设备都能用上面的密码。">
      {devices.map(device => <SettingsRow key={device.deviceId} title={device.label || '未命名设备'} description={device.current ? '本机' : undefined}
        control={device.current ? undefined : <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(device)}>移除</Button>} />)}
      <SettingsRow title="恢复码" description={recovery === 'set' ? '所有设备都丢了时，用它找回密码。' : '未设置'}
        control={recovery === 'set'
          ? <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('regenerate')}>重新生成</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('drop')}>移除</Button></div>
          : <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void create(false) }}>生成</Button>} />
    </SettingsGroup>
    {removing && <Confirm title={`不再同步到 ${removing.label || '这台设备'}？`} action="移除" busy={busy} testId="password-sync-remove-dialog"
      body="它收不到之后新增和修改的密码。它已经存下的密码不会被删掉，需要的话去网站上改密码。"
      onClose={() => setRemoving(undefined)} onConfirm={() => { void run({ type: 'sync-remove', deviceId: removing.deviceId }).then(() => setRemoving(undefined)) }} />}
    {asking === 'regenerate' && <Confirm title="重新生成恢复码？" action="重新生成" busy={busy} testId="password-recovery-regenerate"
      body="旧的恢复码会立刻失效，手上那份要换成新的。" onClose={() => setAsking(undefined)} onConfirm={() => { void create(true) }} />}
    {asking === 'drop' && <Confirm title="移除恢复码？" action="移除" busy={busy} testId="password-recovery-remove"
      body="移除后，所有设备都丢了就找不回这些密码。" onClose={() => setAsking(undefined)}
      onConfirm={() => { void run({ type: 'sync-recovery-remove' }).then(() => setAsking(undefined)) }} />}
    {shown && <RecoveryCodeSheet code={shown.code} fresh={shown.fresh} onClose={() => setShown(undefined)} />}
  </>
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
