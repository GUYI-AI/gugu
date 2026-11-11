/** @jsxImportSource solid-js */
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { PASSWORD_REQUEST_PREFIX, requestPasswordFill, type PasswordBetaUi, type PasswordRequestView, type PasswordUiCommand } from '@gugu/core/shared/passwordBetaProtocol'
import type { ChatMessage } from '@session-chat/model'

export const PASSWORD_CARD_HEIGHT = 292
export function passwordRequest(item: ChatMessage): PasswordRequestView | null {
  if (!PASSWORD_BETA_ENABLED || !item.ownerNotification || !item.text.startsWith(PASSWORD_REQUEST_PREFIX)) return null
  try {
    const value = JSON.parse(item.text.slice(PASSWORD_REQUEST_PREFIX.length)) as PasswordRequestView
    return value.requestId === item.ownerNotification.requestId && typeof value.origin === 'string'
      && typeof value.sessionId === 'string' && typeof value.agent === 'string' ? value : null
  } catch { return null }
}
const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
const line = { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' } as const
const button = { padding: '6px 12px', border: '1px solid var(--border)', 'border-radius': 'var(--radius-control)', background: 'var(--bg-primary)', color: 'inherit', font: 'inherit', cursor: 'pointer' } as const

/** Metadata is visible on replay; acting requires the same native process's actual pending request. */
export function PasswordRequestCard(props: { request: PasswordRequestView }) {
  const save = props.request.kind === 'save'
  const changing = props.request.kind === 'save' && !!props.request.credentialId
  const [current, setCurrent] = createSignal<PasswordRequestView>()
  const [state, setState] = createSignal(save ? '等待你填写' : '等待你批准')
  const [busy, setBusy] = createSignal(false)
  const ui = () => (window as unknown as { passwordVaultBeta?: PasswordBetaUi }).passwordVaultBeta
  const refresh = async () => {
    try {
      const reply = await ui()?.invoke({ type: 'snapshot' })
      const list: PasswordRequestView[] | undefined = reply?.ok ? (save ? reply.snapshot.saves : reply.snapshot.approvals) : undefined
      const pending = list?.find(value => value.requestId === props.request.requestId)
      setCurrent(pending)
      if (!pending) setState('这条请求已结束，或需要在发起的电脑上处理')
    } catch { setCurrent(undefined); setState('当前无法读取这条请求') }
  }
  onMount(() => { void refresh(); const close = ui()?.subscribe(() => { void refresh() }); onCleanup(() => close?.()) })
  const act = async (command: PasswordUiCommand, done: string) => {
    if (!current()) return
    setBusy(true)
    try {
      const result = await ui()?.invoke(command)
      if (result?.ok) { setCurrent(undefined); setState(done) }
      else setState('这条请求已结束，需要时让 Agent 重新发起')
    } catch { setState('当前无法处理，请重试') }
    finally { setBusy(false) }
  }
  // 「去填写」 opens Settings → 密码 on the same add/edit form; the values never travel through this message.
  const fill = () => {
    requestPasswordFill(props.request.requestId)
    window.dispatchEvent(new CustomEvent('__open_settings', { detail: { section: 'passwords' } }))
  }
  const view = () => current() ?? props.request
  const title = save ? `${changing ? '修改' : '保存'} ${host(props.request.origin)} 的密码` : '使用密码登录网站'
  return <section data-password-request={props.request.requestId} style={{ height: `${PASSWORD_CARD_HEIGHT}px`, width: '100%',
    padding: '12px', 'box-sizing': 'border-box', border: '1px solid var(--border)', 'border-radius': '12px',
    display: 'flex', 'flex-direction': 'column', gap: '8px', 'font-size': 'var(--font-body)' }}>
    <strong>{title}</strong>
    <div style={line}>网站：{view().origin}</div>
    <div style={line}>账号：{view().maskedAccount ?? '由你填写'}</div>
    <div style={line}>Agent：{view().agentName || '此 Agent'}</div>
    <div style={line}>会话：{view().sessionTitle || '当前会话'}</div>
    <div>{save ? '你核对或补全后才会保存' : '只用这一次 · 密码不会交给 Agent'}</div>
    <Show when={current()} fallback={<span role="status">{state()}</span>}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <Show when={save} fallback={<>
          <button type="button" style={button} disabled={busy()} onClick={() => { void act({ type: 'decide', requestId: props.request.requestId, decision: 'allow_once' }, '已允许这一次') }}>允许这一次</button>
          <button type="button" style={button} disabled={busy()} onClick={() => { void act({ type: 'decide', requestId: props.request.requestId, decision: 'reject' }, '已拒绝') }}>拒绝</button>
        </>}>
          <button type="button" style={button} disabled={busy()} onClick={fill}>去填写</button>
          <button type="button" style={button} disabled={busy()} onClick={() => { void act({ type: 'reject-save', requestId: props.request.requestId }, '已拒绝') }}>拒绝</button>
        </Show>
      </div>
    </Show>
  </section>
}
