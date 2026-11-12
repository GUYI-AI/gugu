/** @jsxImportSource solid-js */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { PASSWORD_REQUEST_PREFIX, requestPasswordFill, type PasswordApproval, type PasswordBetaUi, type PasswordFillOutcome, type PasswordItem, type PasswordRequestView, type PasswordSaveDraft, type PasswordUiCommand } from '@gugu/core/shared/passwordBetaProtocol'
import type { ChatMessage } from '@session-chat/model'
import { vars } from '@session-chat/styles/theme.css'
import { passwordField, passwordFieldIcons, passwordIconButton, passwordInput, passwordQuietAction, passwordSplitPart, passwordTip } from './password-request-card.css'

/**
 * Anatomy and measures after assistant-ui Elements 「Permission grant」 / 「Approval card」 (a 20px card, a 28px glyph
 * tile beside title and requester, quiet bullets, pill actions with one filled) and 「Create task」 (borderless
 * filled fields). The list is laid out before it is drawn, so every part has a fixed height and the card's follows
 * from its request.
 */
const PAD = 16, GAP = 14, HEAD = 36, NOTE = 16, NOTE_GAP = 4, FOOT = 32
type Fill = NonNullable<PasswordApproval['fills']>[number]
const fills = (request: PasswordRequestView): Fill[] => request.kind === 'save' ? [] : request.fills ?? []
/** What the person weighs before allowing; the second flag marks a caution. */
function notes(request: PasswordRequestView): [string, boolean][] {
  if (request.kind === 'save') return request.maskedAccount ? [[`账号 ${request.maskedAccount}`, false]] : []
  return [...(request.elsewhere ? [[`「${request.credential ?? '这条密码'}」不是为这个网站保存的`, true] as [string, boolean]] : []),
    ...(request.exposed?.length ? [[`${request.exposed.join('、')} 填进的不是密码框，网页能再显示它`, true] as [string, boolean]] : [])]
}
/** A save request is a form in the chat (assistant-ui 「Elicitation form」): a label over each input, the inputs filled. */
const DESC = 20, LABEL = 17, LABEL_GAP = 4, INPUT = 28, INPUT_GAP = 10, CHECK = 20, ADD = 20

/** A value of the person's own, added on the card under a name of theirs (「+ 添加一项」): kept with the rest. */
type Extra = { id: string; name: string; value: string; secret: boolean }
/**
 * Per card, outside it: the items the person added and whether 「存到咕咕」 is off. The list measures a card before drawing
 * it and again whenever these change; they also outlive the card leaving the screen. Dropped once the card is answered.
 */
const [extrasStore, setExtrasStore] = createSignal<Record<string, Extra[]>>({})
const [keepOffStore, setKeepOffStore] = createSignal<Record<string, boolean>>({})
const extrasOf = (requestId: string) => extrasStore()[requestId] ?? []
const setExtras = (requestId: string, next: Extra[]) => setExtrasStore(all => ({ ...all, [requestId]: next }))
const dropCard = (requestId: string) => {
  for (const extra of extrasOf(requestId)) extra.value = ''
  setExtrasStore(({ [requestId]: _gone, ...rest }) => rest); setKeepOffStore(({ [requestId]: _gone, ...rest }) => rest)
}
/** Items can be added where values are being kept: a save request, or a card to fill in with 「存到咕咕」 on. */
const addingOf = (request: PasswordRequestView) => request.kind === 'save' || storingOf(request) && !!request.remember && !keepOffStore()[request.requestId]
// The added rows; a save card also has 「+ 添加一项」 under them (a card to fill in has it on the 「存到咕咕」 row).
const extrasHeight = (request: PasswordRequestView) => !addingOf(request) ? 0
  : extrasOf(request.requestId).length * (INPUT_GAP + INPUT) + (request.kind === 'save' ? INPUT_GAP + ADD : 0)
export function passwordCardHeight(request: PasswordRequestView): number {
  if (request.kind === 'save') {
    const inputs = request.inputs?.length ?? 2
    return PAD * 2 + HEAD + GAP + DESC + GAP + inputs * (LABEL + LABEL_GAP + INPUT) + (inputs - 1) * INPUT_GAP + extrasHeight(request) + GAP + FOOT
  }
  const fields = fills(request).length, marks = notes(request).length
  return PAD * 2 + HEAD
    + (fields ? GAP + fields * (LABEL + LABEL_GAP + INPUT) + (fields - 1) * INPUT_GAP + extrasHeight(request) : 0)
    + (marks ? GAP + marks * NOTE + (marks - 1) * NOTE_GAP : 0)
    + GAP + CHECK
    + GAP + FOOT
}
/** Something on the card is not in the vault yet (typed by the person, or given by the Agent): a card to fill in and keep.
 * Everything saved already: a card to allow this use, once or always. */
function storingOf(request: PasswordRequestView): boolean { return fills(request).some(entry => entry.source !== 'saved') }
export function passwordRequest(item: ChatMessage): PasswordRequestView | null {
  if (!PASSWORD_BETA_ENABLED || !item.ownerNotification || !item.text.startsWith(PASSWORD_REQUEST_PREFIX)) return null
  try {
    const value = JSON.parse(item.text.slice(PASSWORD_REQUEST_PREFIX.length)) as PasswordRequestView
    return value.requestId === item.ownerNotification.requestId && typeof value.origin === 'string'
      && typeof value.sessionId === 'string' && typeof value.agent === 'string' ? value : null
  } catch { return null }
}
function host(origin: string) { try { return new URL(origin).host } catch { return origin } }
const clip = { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'min-width': 0 } as const
const tint = (percent: number) => `color-mix(in srgb, ${vars.fg} ${percent}%, transparent)`
const action = { height: `${FOOT}px`, padding: '0 12px', border: 'none', 'border-radius': '999px', font: 'inherit', 'font-size': '12px', 'line-height': '16px', 'font-weight': 500,
  'white-space': 'nowrap', cursor: 'pointer', display: 'inline-flex', 'align-items': 'center', 'box-sizing': 'border-box' } as const
const quiet = { ...action, background: 'transparent', color: vars.fgMuted } as const
const solid = { ...action, background: vars.fg, color: vars.bg } as const
/** The two halves of 「允许这一次 ▾」: one pill, no background of their own. */
const split = { ...action, height: '100%', 'border-radius': 0, background: 'transparent', color: vars.bg } as const
const label = { ...clip, display: 'flex', 'align-items': 'center', gap: '4px', height: `${LABEL}px`, 'font-size': '11px', 'line-height': `${LABEL}px`, 'font-family': vars.fontMono, color: vars.fgMuted } as const
const input = { display: 'block', width: '100%', height: `${INPUT}px`, padding: '6px 10px', 'box-sizing': 'border-box', border: 'none', outline: 'none', 'border-radius': '8px',
  background: tint(4), color: tint(80), font: 'inherit', 'font-size': '12px', 'line-height': '16px' } as const
/** `key-linear`, the same glyph as `KeyRound` in `@gugu/session-ui` (this package cannot import that one). */
const IconKey = () => <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5">
  <path stroke-linejoin="round" d="M15.68 14.587c3.49 0 6.32-2.818 6.32-6.294S19.17 2 15.68 2S9.363 4.818 9.363 8.293c0 1.61.734 2.781.734 2.781l-7.642 7.61c-.343.342-.823 1.23 0 2.05l.882.878c.343.293 1.205.703 1.91 0l1.03-1.024c1.028 1.024 2.204.439 2.645-.147c.734-1.024-.147-2.049-.147-2.049l.294-.293c1.41 1.406 2.645.586 3.086 0c.735-1.024 0-2.049 0-2.049c-.294-.585-.882-.585-.147-1.317l.882-.878c.705.585 2.155.732 2.792.732Z" />
  <path d="M17.885 8.294a2.2 2.2 0 0 1-2.204 2.195a2.2 2.2 0 0 1-2.204-2.195a2.2 2.2 0 0 1 2.204-2.196a2.2 2.2 0 0 1 2.204 2.196Z" /></g></svg>

const IconEye = (props: { off?: boolean }) => <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" />{props.off ? <path d="M4 4l16 16" /> : null}</g></svg>
const IconLock = (props: { open?: boolean }) => <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d={props.open ? 'M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2' : 'M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3'} /></g></svg>
const IconClose = () => <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>

/**
 * One input as in Settings → 密码: a hidden value shows on the eye; the lock marks it 保密 (the Agent can only fill it in,
 * never read it) or not. Both appear on hover or focus, inside the input, after the text (no box in a box).
 */
function CardField(props: { value: string; placeholder: string; secret: boolean; lockable: boolean; disabled: boolean; readOnly?: boolean; autocomplete?: string
  label?: string; onInput(value: string): void; onSecret?(secret: boolean): void; onEnter?(): void; onRemove?(): void }) {
  const [shown, setShown] = createSignal(false)
  const icons = () => (props.secret && !props.readOnly ? 1 : 0) + (props.lockable ? 1 : 0) + (props.onRemove ? 1 : 0)
  return <div class={passwordField} style={{ position: 'relative', flex: '1 1 0', 'min-width': 0, height: `${INPUT}px` }}>
    <input type={props.secret && !shown() ? 'password' : 'text'} autocomplete={props.autocomplete ?? 'off'} spellcheck={false} aria-label={props.label} disabled={props.disabled} readOnly={props.readOnly}
      style={{ ...input, 'padding-right': `${10 + icons() * 24}px` }} class={passwordInput} value={props.value} placeholder={props.placeholder}
      onInput={event => props.onInput(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing) props.onEnter?.() }} />
    <Show when={icons() && !props.disabled}>
      <span class={passwordFieldIcons} style={{ position: 'absolute', right: '2px', top: '2px', display: 'flex' }}>
        <Show when={props.secret && !props.readOnly}>
          <button type="button" class={passwordIconButton} aria-label={shown() ? '隐藏' : '显示'} aria-pressed={shown()} onClick={() => setShown(value => !value)}><IconEye off={shown()} /></button>
        </Show>
        <Show when={props.lockable}>
          <button type="button" class={passwordIconButton} aria-label={props.secret ? '保密：智能体只能代填，看不到。点一下改成不保密' : '不保密：智能体能看到。点一下改成保密'} aria-pressed={props.secret}
            title={props.secret ? '保密' : '不保密'} onClick={() => { setShown(false); props.onSecret?.(!props.secret) }}><IconLock open={!props.secret} /></button>
        </Show>
        <Show when={props.onRemove}>
          <button type="button" class={passwordIconButton} aria-label="删掉这一项" onClick={() => props.onRemove?.()}><IconClose /></button>
        </Show>
      </span>
    </Show>
  </div>
}

/** 「+ 添加一项」: one more item of the person's own (a name and a value, 保密 unless unlocked). */
function AddExtra(props: { requestId: string; disabled: boolean }) {
  const list = () => extrasOf(props.requestId)
  return <button type="button" class={passwordQuietAction} disabled={props.disabled || list().length >= 16}
    style={{ ...quiet, height: `${ADD}px`, padding: '0 6px', 'border-radius': '6px', 'font-weight': 400 }}
    onClick={() => setExtras(props.requestId, [...list(), { id: crypto.randomUUID(), name: '', value: '', secret: true }])}>+ 添加一项</button>
}

/** The items the person added, a name and a value each; with `add`, 「+ 添加一项」 under them. */
function ExtraRows(props: { requestId: string; disabled: boolean; add?: boolean; onEnter(): void }) {
  const list = () => extrasOf(props.requestId)
  const change = (id: string, patch: Partial<Extra>) => setExtras(props.requestId, list().map(extra => extra.id === id ? { ...extra, ...patch } : extra))
  return <>
    <For each={list()}>{extra => <div style={{ display: 'flex', gap: '8px', height: `${INPUT}px` }}>
      <input type="text" spellcheck={false} aria-label="名称" placeholder="名称" disabled={props.disabled} class={passwordInput} style={{ ...input, flex: '0 0 36%', width: '36%' }}
        value={extra.name} onInput={event => change(extra.id, { name: event.currentTarget.value })} />
      <CardField value={extra.value} placeholder="值" label={extra.name || '值'} secret={extra.secret} lockable disabled={props.disabled} onEnter={props.onEnter}
        onInput={value => change(extra.id, { value })} onSecret={secret => change(extra.id, { secret })}
        onRemove={() => setExtras(props.requestId, list().filter(entry => entry.id !== extra.id))} />
    </div>}</For>
    <Show when={props.add}><div style={{ display: 'flex', 'margin-inline-start': '-6px' }}><AddExtra requestId={props.requestId} disabled={props.disabled} /></div></Show>
  </>
}
/** What 「+ 添加一项」 adds, complete: a name and a value each. Half-filled ones hold the card back. */
const extrasReady = (requestId: string) => extrasOf(requestId).every(extra => !extra.name.trim() && !extra.value || extra.name.trim() && extra.value)
const extrasFilled = (requestId: string) => extrasOf(requestId).filter(extra => extra.name.trim() && extra.value)

/** The card's last line once the person approved: where the fill is, then what 「记住」 did once the login went through. */
function outcomeText(result: string, keep: PasswordFillOutcome['keep'], storing: boolean): string {
  switch (result) {
    case 'approved': case 'running': return '正在填入…'
    case 'filled': return keep === 'waiting' ? `已填入，登录成功后${storing ? '存到咕咕' : '生效'}` : keep === 'kept' ? (storing ? '已填入，已存到咕咕' : '已填入，以后不再问')
      : keep === 'dropped' ? `已填入；没登录上，${storing ? '没有存' : '下次还会问'}` : '已填入'
    case 'rejected': return '已拒绝'
    case 'expired': return '已过期，需要时让 Agent 重新发起'
    case 'unavailable': case 'uncertain': return '没填成，网页可能已经变了'
    default: return '这条请求已结束'
  }
}

/** Metadata is visible on replay; acting requires the same native process's actual pending request. */
export function PasswordRequestCard(props: { request: PasswordRequestView }) {
  const save = props.request.kind === 'save'
  const changing = props.request.kind === 'save' && !!props.request.credentialId
  const [current, setCurrent] = createSignal<PasswordRequestView>()
  const [state, setState] = createSignal(save ? '等待你填写' : '等待你批准')
  const [busy, setBusy] = createSignal(false)
  // Once this card settled the request (已允许 / 已拒绝), the refresh its own action triggers must not overwrite that.
  let settled = false
  const ui = () => (window as unknown as { passwordVaultBeta?: PasswordBetaUi }).passwordVaultBeta
  const refresh = async () => {
    try {
      const reply = await ui()?.invoke({ type: 'snapshot' })
      const list: PasswordRequestView[] | undefined = reply?.ok ? (save ? reply.snapshot.saves : reply.snapshot.approvals) : undefined
      const pending = list?.find(value => value.requestId === props.request.requestId)
      setCurrent(pending)
      // After 「填入」 the card follows the use itself: what the site did, and whether anything was kept.
      const outcome = reply?.ok && !save ? reply.snapshot.outcomes?.find(value => value.requestId === props.request.requestId) : undefined
      if (outcome) { settled = true; setState(outcomeText(outcome.result, outcome.keep, fills(props.request).some(entry => entry.source !== 'saved'))) }
      else if (!pending && !settled) setState('这条请求已结束，或需要在发起的电脑上处理')
    } catch { setCurrent(undefined); setState('当前无法读取这条请求') }
  }
  onMount(() => { void refresh(); const close = ui()?.subscribe(() => { void refresh() }); onCleanup(() => close?.()) })
  const act = async (command: PasswordUiCommand, done: string) => {
    if (!current()) return
    setBusy(true)
    try {
      const result = await ui()?.invoke(command)
      if (result?.ok) { settled = true; setCurrent(undefined); setState(done) }
      else setState('这条请求已结束，需要时让 Agent 重新发起')
    } catch { setState('当前无法处理，请重试') }
    finally { setBusy(false) }
  }
  // 「去填写」 opens Settings → 密码 on the same add/edit form; the values never travel through this message.
  const fill = () => {
    requestPasswordFill(props.request.requestId)
    window.dispatchEvent(new CustomEvent('__open_settings', { detail: { section: 'passwords' } }))
  }
  /**
   * The person fills the request right here and saves; values go from these inputs to the vault through the person's
   * own command, as in Settings → 密码. What the Agent proposed (never part of this message) pre-fills the inputs.
   * 「在设置里编辑」 opens the full form for the rest (name, secret marks).
   */
  function saveCard(request: Extract<PasswordRequestView, { kind: 'save' }>) {
    const inputs = request.inputs ?? [{ key: 'account', name: '账号', secret: false }, { key: 'password', name: '密码', secret: true }]
    const [values, setValues] = createSignal<Record<string, string>>({})
    let draft: PasswordSaveDraft | undefined, item: PasswordItem | undefined, loaded = false
    const load = async () => {
      if (loaded) return
      loaded = true
      try {
        const reply = await ui()?.invoke({ type: 'save-draft', requestId: request.requestId })
        if (!reply?.ok || !reply.draft) return
        draft = reply.draft
        item = request.credentialId ? reply.snapshot.items.find(entry => entry.reference.id === request.credentialId) : undefined
        setValues({ account: draft.account, password: draft.password, ...Object.fromEntries(draft.fields.map(field => [field.id, field.value])) })
      } catch { loaded = false }
    }
    onMount(() => { void load() })
    onCleanup(() => setValues({}))
    // A value already stored may stay blank (blank keeps it); a new one must be filled.
    const stored = (key: string) => key === 'account' ? !!item?.maskedAccount : key === 'password' ? !!item?.hasPassword : !!item?.fields.some(field => field.id === key)
    // 保密 per input, as the person sets it with the lock (the password always is).
    const [secrets, setSecrets] = createSignal<Record<string, boolean>>({})
    const secretOf = (entry: (typeof inputs)[number]) => entry.key === 'password' || (secrets()[entry.key] ?? entry.secret)
    const ready = () => inputs.every(entry => stored(entry.key) || (values()[entry.key] ?? '').trim()) && extrasReady(request.requestId)
    const submit = () => {
      if (!current() || !ready() || busy()) return
      const typed = values()
      const proposed = draft?.fields ?? []
      const marked = (id: string, fallback: boolean) => secrets()[id] ?? fallback
      const fields = [...(item?.fields ?? []).map(field => ({ id: field.id, name: field.name, value: typed[field.id] ?? '', secret: marked(field.id, field.secret) })),
        ...proposed.filter(field => !item?.fields.some(entry => entry.id === field.id)).map(field => ({ ...field, value: typed[field.id] ?? '', secret: marked(field.id, !!field.secret) })),
        ...extrasFilled(request.requestId).map(extra => ({ id: extra.id, name: extra.name.trim(), value: extra.value, secret: extra.secret }))]
      const account = inputs.find(entry => entry.key === 'account')
      void act({ type: 'save', origin: request.origin, name: draft?.name ?? item?.name ?? '', account: typed.account ?? '',
        accountSecret: account ? secretOf(account) : undefined, password: typed.password ?? '', fields, sites: item?.sites,
        ...(item ? { reference: item.reference } : {}), requestId: request.requestId }, changing ? '已保存修改' : '已保存').then(() => { setValues({}); dropCard(request.requestId) })
    }
    const site = host(request.origin)
    return <section data-password-request={request.requestId} style={{ height: `${passwordCardHeight(request)}px`, width: '100%', 'max-width': '400px',
      padding: `${PAD}px`, 'box-sizing': 'border-box', border: `1px solid ${tint(10)}`, 'border-radius': '20px', background: vars.bg, overflow: 'hidden',
      display: 'flex', 'flex-direction': 'column', gap: `${GAP}px`, 'font-family': vars.fontSans, color: vars.fg }}>
      <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', height: `${HEAD}px`, 'flex-shrink': 0 }}>
        <span style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', width: '28px', height: '28px', 'border-radius': '8px', background: tint(5), color: vars.fgMuted, 'flex-shrink': 0 }}><IconKey /></span>
        <div style={{ display: 'flex', 'flex-direction': 'column', 'min-width': 0, flex: '1 1 0' }}>
          <span style={{ ...clip, 'font-size': '13.5px', 'line-height': '20px', 'font-weight': 500 }}>{`${changing ? '修改' : '保存'} ${site} 的${inputs.some(entry => entry.key === 'password') ? '密码' : ` ${inputs.map(entry => entry.name).join('、')}`}`}</span>
          <span style={{ ...clip, 'font-size': '12px', 'line-height': '16px', color: vars.fgMuted }}>{request.agentName || '此智能体'} · {request.sessionTitle || '当前会话'}</span>
        </div>
      </div>
      <p style={{ ...clip, margin: 0, height: `${DESC}px`, 'font-size': '12px', 'line-height': `${DESC}px`, color: vars.fgMuted, 'flex-shrink': 0 }}>存进保险箱后，保密的值智能体只能代填，看不到。</p>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: `${INPUT_GAP}px`, 'flex-shrink': 0 }}>
        {inputs.map(entry => <div style={{ display: 'flex', 'flex-direction': 'column', gap: `${LABEL_GAP}px` }}>
          <span style={label}>{entry.name}<Show when={secretOf(entry)}><span style={{ opacity: 0.7 }}>· 保密</span></Show></span>
          <CardField value={values()[entry.key] ?? ''} label={entry.name} secret={secretOf(entry)} lockable={entry.key !== 'password'} disabled={!current() || busy()}
            autocomplete={entry.key === 'password' ? 'new-password' : 'off'} placeholder={stored(entry.key) ? '已保存，留空不改' : entry.key === 'account' ? '邮箱或用户名' : ''}
            onInput={value => setValues(list => ({ ...list, [entry.key]: value }))} onSecret={secret => setSecrets(list => ({ ...list, [entry.key]: secret }))} onEnter={submit} />
        </div>)}
        <ExtraRows requestId={request.requestId} disabled={!current() || busy()} add onEnter={submit} />
      </div>
      <div style={{ height: `${FOOT}px`, display: 'flex', 'align-items': 'center', gap: '8px', 'flex-shrink': 0 }}>
        <Show when={current()} fallback={<span role="status" style={{ ...clip, 'font-size': '12px', 'line-height': '16px', color: vars.fgMuted }}>{state()}</span>}>
          <button type="button" style={{ ...quiet, 'padding-inline-start': 0 }} class={passwordQuietAction} disabled={busy()} onClick={fill}>在设置里编辑</button>
          <span style={{ flex: '1 1 0' }} />
          <button type="button" style={quiet} class={passwordQuietAction} disabled={busy()} onClick={() => { void act({ type: 'reject-save', requestId: request.requestId }, '已拒绝').then(() => dropCard(request.requestId)) }}>拒绝</button>
          <button type="button" style={{ ...solid, opacity: ready() ? 1 : 0.4, cursor: ready() ? 'pointer' : 'default' }} disabled={busy() || !ready()} onClick={submit}>保存</button>
        </Show>
      </div>
    </section>
  }
  const view = () => current() ?? props.request
  const use = props.request.kind === 'save' ? undefined : props.request
  const site = host(props.request.origin)
  // The ask in the person's words: a password among the values is a login; anything else is filling in.
  const title = save ? `${changing ? '修改' : '保存'} ${site} 的密码` : !use?.fills?.length || use.fills.some(fill => fill.value === '密码') ? `登录 ${site}` : `在 ${site} 填入`
  /**
   * Keeping and using are two steps. A value not in the vault yet: the person types it, 「填入」 fills the page, and
   * 「存到咕咕」 keeps it (allowing nobody). A saved value: the person allows this use, once or always (this Agent, on
   * this website, without asking again); a secret going into an ordinary input is allowed once at a time.
   */
  const [typed, setTyped] = createSignal<Record<number, string>>({})
  const storing = storingOf(props.request)
  const agent = () => view().agentName || '这个智能体'
  /** Already in the vault: the same row, ticked and fixed, saying where it is. */
  const stored = () => item()?.name || (use?.credential) || site
  const tip = () => storing ? `加密保存在咕咕，开了同步的设备也能用。之后${agent()}要用，还会先问你。` : `已经存在咕咕里（${stored()}）。要删掉，去 设置 → 密码。`
  /** The row can be changed only for values not saved yet, and only where keeping them is offered. */
  const choosable = () => storing && !!use?.remember && !!current() && !busy()
  /** 「始终允许」 is offered where a standing allowance may be given (not into an input that shows the secret). */
  const always = !storing && use?.remember === 'auto'
  const [menu, setMenu] = createSignal(false)
  const closeMenu = (event: Event) => { if (!(event.target as Element | null)?.closest?.('[data-password-menu]')) setMenu(false) }
  onMount(() => { document.addEventListener('pointerdown', closeMenu, true); onCleanup(() => document.removeEventListener('pointerdown', closeMenu, true)) })
  /** 「存到咕咕」 is on unless the person unticked it (kept outside the card: the card's height follows it). */
  const remember = () => !keepOffStore()[props.request.requestId]
  const setRemember = (on: boolean) => setKeepOffStore(all => ({ ...all, [props.request.requestId]: !on }))
  /** 保密 per typed value, as the person sets it with the lock (the password always is). */
  const [secretAt, setSecretAt] = createSignal<Record<number, boolean>>({})
  const secretOf = (entry: Fill, index: number) => entry.key === 'password' || (secretAt()[index] ?? !!entry.secret)
  const [item, setItem] = createSignal<PasswordItem>()
  onMount(() => {
    const credentialId = props.request.kind === 'save' ? undefined : props.request.credentialId
    if (credentialId) void ui()?.invoke({ type: 'snapshot' }).then(reply => { if (reply?.ok) setItem(reply.snapshot.items.find(entry => entry.reference.id === credentialId)) }).catch(() => {})
  })
  onCleanup(() => setTyped({}))
  /** What an input starts with: a value the Agent gave, or a saved one that is not secret (from the person's own snapshot). */
  const preset = (entry: Fill) => {
    if (entry.source === 'given') return entry.given ?? ''
    if (entry.secret || entry.source === 'missing') return ''
    const value = item()
    return (entry.key === 'account' ? value?.account : value?.fields.find(field => field.id === entry.key)?.value) ?? ''
  }
  const text = (entry: Fill, index: number) => typed()[index] ?? preset(entry)
  const ready = () => fills(props.request).every((entry, index) => entry.source !== 'missing' || text(entry, index).trim()) && (!addingOf(props.request) || extrasReady(props.request.requestId))
  const decide = (decision: 'allow_once' | 'reject', done: string, allowAlways = false) => {
    if (decision !== 'reject' && !ready()) return
    setMenu(false)
    const list = fills(props.request).map((entry, index) => { const value = typed()[index]; return value !== undefined && value !== preset(entry) ? value : '' })
    // `remember`: on a card to fill in, keep what was typed; on a card to allow, allow always.
    const keep = decision !== 'reject' && !!use?.remember && (storing ? remember() : allowAlways)
    // With 「存到咕咕」: how each value is to be kept (保密 or not), and the items the person added.
    const keeping = keep && storing
    const extra = keeping ? extrasFilled(props.request.requestId).map(entry => ({ name: entry.name.trim(), value: entry.value, secret: entry.secret })) : []
    void act({ type: 'decide', requestId: props.request.requestId, decision, ...(decision !== 'reject' && list.some(Boolean) ? { typed: list } : {}), ...(keep ? { remember: true } : {}),
      ...(keeping ? { secret: fills(props.request).map(secretOf) } : {}), ...(extra.length ? { extra } : {}) }, done).then(() => { setTyped({}); dropCard(props.request.requestId) })
  }
  if (props.request.kind === 'save') return saveCard(props.request)
  return <section data-password-request={props.request.requestId} style={{ height: `${passwordCardHeight(props.request)}px`, width: '100%', 'max-width': '400px',
    padding: `${PAD}px`, 'box-sizing': 'border-box', border: `1px solid ${tint(10)}`, 'border-radius': '20px', background: vars.bg, overflow: 'hidden',
    display: 'flex', 'flex-direction': 'column', gap: `${GAP}px`, 'font-family': vars.fontSans, color: vars.fg }}>
    <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', height: `${HEAD}px`, 'flex-shrink': 0 }}>
      <span style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', width: '28px', height: '28px', 'border-radius': '8px', background: tint(5), color: vars.fgMuted, 'flex-shrink': 0 }}><IconKey /></span>
      <div style={{ display: 'flex', 'flex-direction': 'column', 'min-width': 0 }}>
        <span style={{ ...clip, 'font-size': '13.5px', 'line-height': '20px', 'font-weight': 500 }}>{title}</span>
        <span style={{ ...clip, 'font-size': '12px', 'line-height': '16px', color: vars.fgMuted }}>{view().agentName || '此智能体'} · {view().sessionTitle || '当前会话'}</span>
      </div>
    </div>
    <Show when={fills(props.request).length}>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: `${INPUT_GAP}px`, 'flex-shrink': 0 }}>
        {/* The page's own form, input by input: its name for the input over an input holding what goes in. A non-secret
            value shows as it is; a secret one stays hidden and is the stored one unless the person types another here,
            which replaces it for this use only. */}
        {fills(props.request).map((entry, index) => <div style={{ display: 'flex', 'flex-direction': 'column', gap: `${LABEL_GAP}px` }}>
          <span style={label}><span style={clip}>{entry.input || entry.value}</span>
            <Show when={entry.input && entry.input !== entry.value}><span style={{ 'flex-shrink': 0, opacity: 0.7 }}>· {entry.value}</span></Show>
            <Show when={entry.plain}><span style={{ 'flex-shrink': 0, color: vars.fgPermission }}>· 明文</span></Show>
            <Show when={entry.source !== 'saved' && storing && remember() && secretOf(entry, index)}><span style={{ 'flex-shrink': 0, opacity: 0.7 }}>· 保密</span></Show></span>
          {/* A value to keep can be looked at and marked 保密 or not, as in Settings; a saved one is only shown. */}
          <CardField value={text(entry, index)} label={entry.input || entry.value} secret={entry.source === 'saved' ? !!entry.secret : secretOf(entry, index)}
            lockable={entry.source !== 'saved' && storing && !!use?.remember && remember() && entry.key !== 'password'} readOnly={!storing} disabled={!current() || busy()}
            placeholder={entry.source === 'missing' ? `填${/^[\x21-\x7e]/.test(entry.value) ? ' ' : ''}${entry.value}` : entry.secret ? '已保存' : ''}
            onInput={value => setTyped(list => ({ ...list, [index]: value }))} onSecret={secret => setSecretAt(list => ({ ...list, [index]: secret }))}
            onEnter={() => decide('allow_once', '正在填入…')} />
        </div>)}
        <Show when={addingOf(props.request)}><ExtraRows requestId={props.request.requestId} disabled={!current() || busy()} onEnter={() => decide('allow_once', '正在填入…')} /></Show>
      </div>
    </Show>
    <Show when={notes(props.request).length}>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: `${NOTE_GAP}px`, 'flex-shrink': 0 }}>
        {notes(props.request).map(([note, caution]) => <span title={note} style={{ display: 'flex', 'align-items': 'center', gap: '8px', height: `${NOTE}px`, 'font-size': '12px', 'line-height': '16px', color: caution ? vars.fg : tint(60) }}>
          <span aria-hidden="true" style={{ width: '4px', height: '4px', 'border-radius': '50%', background: caution ? vars.fgPermission : tint(20), 'flex-shrink': 0 }} /><span style={clip}>{note}</span></span>)}
      </div>
    </Show>
    {/* Every card has this row: a value not saved yet may be kept or not; a saved one shows it is kept. Keeping, the
        person may add items of their own, on the right. */}
    <div style={{ display: 'flex', 'align-items': 'center', height: `${CHECK}px`, 'flex-shrink': 0 }}>
    <label style={{ position: 'relative', display: 'flex', 'align-items': 'center', gap: '8px', height: `${CHECK}px`, 'font-size': '12px', 'line-height': '16px', color: choosable() ? vars.fg : vars.fgMuted, cursor: choosable() ? 'pointer' : 'default', 'flex-shrink': 0 }}>
      <input type="checkbox" checked={storing ? !!use?.remember && remember() : true} disabled={!choosable()} onChange={event => setRemember(event.currentTarget.checked)} style={{ margin: 0, width: '14px', height: '14px', 'accent-color': vars.fg }} />
      存到咕咕
      <span role="img" tabindex="0" aria-label={tip()} data-tip={tip()} class={passwordTip}>i</span>
    </label>
    <Show when={addingOf(props.request) && current()}><span style={{ display: 'flex', 'margin-inline-start': 'auto', 'margin-inline-end': '-6px' }}><AddExtra requestId={props.request.requestId} disabled={!current() || busy()} /></span></Show>
    </div>
    <div style={{ position: 'relative', height: `${FOOT}px`, display: 'flex', 'align-items': 'center', 'justify-content': 'flex-end', gap: '8px', 'flex-shrink': 0 }}>
      <Show when={current()} fallback={<span role="status" style={{ ...clip, 'font-size': '12px', 'line-height': '16px', color: vars.fgMuted, 'margin-inline-end': 'auto' }}>{state()}</span>}>
        <button type="button" style={quiet} class={passwordQuietAction} disabled={busy()} onClick={() => decide('reject', '已拒绝')}>拒绝</button>
        <Show when={menu()}>
          <div role="menu" data-password-menu style={{ position: 'absolute', right: 0, bottom: `calc(100% + 6px)`, padding: '4px', 'border-radius': '12px', background: vars.bg,
            border: `1px solid ${tint(10)}`, 'box-shadow': `0 6px 24px ${tint(12)}`, 'z-index': 1 }}>
            <button type="button" role="menuitem" class={passwordQuietAction} onClick={() => decide('allow_once', '正在填入…', true)}
              style={{ ...quiet, color: vars.fg, height: '32px', 'border-radius': '8px', padding: '0 10px' }}>始终允许</button>
          </div>
        </Show>
        <Show when={storing} fallback={
          // 「允许这一次」 with 「始终允许」 folded under its arrow.
          <div data-password-menu style={{ display: 'flex', 'align-items': 'stretch', height: `${FOOT}px`, 'border-radius': '999px', background: vars.fg, overflow: 'hidden' }}>
            <button type="button" class={passwordSplitPart} style={{ ...split, 'padding-inline': always ? '12px 10px' : '12px' }} disabled={busy()}
              onClick={() => decide('allow_once', '正在填入…')}>允许这一次</button>
            <Show when={always}>
              <span aria-hidden="true" style={{ width: '1px', margin: '8px 0', background: `color-mix(in srgb, ${vars.bg} 28%, transparent)` }} />
              <button type="button" aria-label="更多" aria-haspopup="menu" aria-expanded={menu()} class={passwordSplitPart} style={{ ...split, padding: '0 10px 0 8px' }}
                disabled={busy()} onClick={() => setMenu(value => !value)}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
            </Show>
          </div>}>
          <button type="button" style={{ ...solid, opacity: ready() ? 1 : 0.4, cursor: ready() ? 'pointer' : 'default' }} disabled={busy() || !ready()}
            onClick={() => decide('allow_once', '正在填入…')}>填入</button>
        </Show>
      </Show>
    </div>
  </section>
}
