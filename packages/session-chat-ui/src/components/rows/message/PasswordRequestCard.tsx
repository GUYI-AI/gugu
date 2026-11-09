/** @jsxImportSource solid-js */
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { PASSWORD_REQUEST_PREFIX, type PasswordApproval, type PasswordBetaUi } from '@gugu/core/shared/passwordBetaProtocol'
import type { ChatMessage } from '@session-chat/model'

export const PASSWORD_CARD_HEIGHT = 292
export function passwordRequest(item: ChatMessage): PasswordApproval | null {
  if (!PASSWORD_BETA_ENABLED || !item.ownerNotification || !item.text.startsWith(PASSWORD_REQUEST_PREFIX)) return null
  try {
    const value = JSON.parse(item.text.slice(PASSWORD_REQUEST_PREFIX.length)) as PasswordApproval
    return value.requestId === item.ownerNotification.requestId && typeof value.origin === 'string'
      && typeof value.sessionId === 'string' && typeof value.agent === 'string' ? value : null
  } catch { return null }
}
/** Metadata is visible on replay; deciding requires the same native process's actual pending request. */
export function PasswordRequestCard(props: { request: PasswordApproval }) {
  const [current, setCurrent] = createSignal<PasswordApproval>()
  const [state, setState] = createSignal('等待你批准')
  const [busy, setBusy] = createSignal(false)
  const ui = () => (window as unknown as { passwordVaultBeta?: PasswordBetaUi }).passwordVaultBeta
  const refresh = async () => {
    try {
      const reply = await ui()?.invoke({ type: 'snapshot' })
      const pending = reply?.ok ? reply.snapshot.approvals.find(value => value.requestId === props.request.requestId) : undefined
      setCurrent(pending)
      if (!pending) setState('这条请求已结束，或需要在发起的电脑上处理')
    } catch { setCurrent(undefined); setState('当前无法读取这条请求') }
  }
  onMount(() => { void refresh(); const close = ui()?.subscribe(() => { void refresh() }); onCleanup(() => close?.()) })
  const decide = async (decision: 'allow_once' | 'reject') => {
    if (!current()) return
    setBusy(true)
    try {
      const result = await ui()?.invoke({ type: 'decide', requestId: props.request.requestId, decision })
      if (result?.ok) { setCurrent(undefined); setState(decision === 'allow_once' ? '已批准这次使用' : '已拒绝') }
      else setState('未能批准，请重新发起请求')
    } catch { setState('当前无法处理，请重试') }
    finally { setBusy(false) }
  }
  return <section data-password-request={props.request.requestId} style={{ height: `${PASSWORD_CARD_HEIGHT}px`, width: '100%',
    padding: '12px', 'box-sizing': 'border-box', border: '1px solid var(--border)', 'border-radius': '12px',
    display: 'flex', 'flex-direction': 'column', gap: '8px', 'font-size': 'var(--font-body)' }}>
    <strong>使用密码登录网站</strong>
    <div style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>网站：{current()?.origin ?? props.request.origin}</div>
    <div style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>账号：{current()?.maskedAccount ?? props.request.maskedAccount}</div>
    <div style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>Agent：{current()?.agentName ?? props.request.agentName ?? '此 Agent'}</div>
    <div style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>会话：{current()?.sessionTitle ?? props.request.sessionTitle ?? '当前会话'}</div>
    <div>用途：网页登录</div><div>许可：这次使用 · 不保存长期许可</div>
    <Show when={current()} fallback={<span role="status">{state()}</span>}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" style={{ padding: "6px 12px", border: "1px solid var(--border)", "border-radius": "var(--radius-control)", background: "var(--bg-primary)", color: "inherit", font: "inherit", cursor: "pointer" }} disabled={busy()} onClick={() => { void decide('allow_once') }}>允许这次</button>
        <button type="button" style={{ padding: "6px 12px", border: "1px solid var(--border)", "border-radius": "var(--radius-control)", background: "var(--bg-primary)", color: "inherit", font: "inherit", cursor: "pointer" }} disabled={busy()} onClick={() => { void decide('reject') }}>拒绝</button>
      </div>
    </Show>
  </section>
}
