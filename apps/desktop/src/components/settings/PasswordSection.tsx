import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { PasswordBetaUi, PasswordSnapshot, PasswordUiCommand } from '@gugu/core/shared/passwordBetaProtocol'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, Toggle } from './SettingsPrimitives'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'

declare global { interface Window { passwordVaultBeta?: PasswordBetaUi } }
export function PasswordSection({ actionsHost }: { actionsHost?: () => HTMLElement | null } = {}) {
  const [snapshot, setSnapshot] = useState<PasswordSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [origin, setOrigin] = useState(''), [account, setAccount] = useState(''), [password, setPassword] = useState('')
  const [setup, setSetup] = useState<{ setupId: string; recoveryMaterial: string }>()
  const invoke = useCallback(async (command: PasswordUiCommand) => {
    const reply = await window.passwordVaultBeta?.invoke(command)
    if (!reply?.ok) { setError(reply?.code === 'CANNOT_UNLOCK' ? '未能完成本机身份验证，请重试。' : '当前无法完成，请解锁保险箱后重试。'); return false }
    setSnapshot(reply.snapshot); setError('')
    if (reply.setup) setSetup(reply.setup)
    return true
  }, [])
  useEffect(() => {
    if (!PASSWORD_BETA_ENABLED) return
    void invoke({ type: 'snapshot' })
    return window.passwordVaultBeta?.subscribe(() => { void invoke({ type: 'snapshot' }) })
  }, [invoke])
  const run = async (command: PasswordUiCommand) => {
    setBusy(true)
    try { return await invoke(command) } catch { setError('当前无法完成，请稍后重试。'); return false } finally { setBusy(false) }
  }
  const closeAdd = () => { setAdding(false); setPassword(''); setAccount(''); setOrigin('') }
  if (!PASSWORD_BETA_ENABLED) return null
  const actions = snapshot?.status === 'unlocked' ? <div className="flex justify-end gap-2">
      <Button disabled={busy} onClick={() => setAdding(true)}>添加密码</Button>
      <Button variant="ghost" disabled={busy} onClick={() => { void run({ type: 'lock' }) }}>立即锁定</Button>
    </div> : null
  const host = actionsHost?.()
  return <SettingsPage data-testid="password-settings">
    {host ? createPortal(actions, host) : actions}
    <SettingsGroup title="Agent 使用">
      <SettingsRow title="对所有 Agent 禁止" control={<Toggle ariaLabel="对所有 Agent 禁止" checked={snapshot?.denied ?? false}
        onChange={value => { void run({ type: 'deny', value }) }} />} />
      <SettingsRow title="每次使用" control={<span>由你批准</span>} />
    </SettingsGroup>
    <SettingsGroup title="已保存的密码" footer={<SettingsNote>密码只保存在这台电脑。Agent 只能请求使用，无法查看密码。</SettingsNote>}>
      {!snapshot?.initialized ? <SettingsRow title="设置本机密码保险箱" control={<Button disabled={busy || !snapshot} onClick={() => { void run({ type: 'begin-setup' }) }}>设置</Button>} />
        : snapshot.status !== 'unlocked' ? <SettingsRow title="保险箱已锁定" control={<Button disabled={busy} onClick={() => { void run({ type: 'unlock' }) }}>解锁</Button>} />
          : <>
            {snapshot.items.map(item => <SettingsRow key={item.reference.id} title={item.origin} description={item.maskedAccount}
              control={<Button variant="ghost" disabled={busy} onClick={() => { void run({ type: 'delete', reference: item.reference }) }}>删除</Button>} />)}
            {!snapshot.items.length && <SettingsNote>还没有保存密码</SettingsNote>}
          </>}
    </SettingsGroup>
    {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    <SettingsNote>防止 Agent 误看到密码；防不住恶意网站，只在你信任的网站上用。</SettingsNote>
    <Dialog.Root open={adding} onOpenChange={open => { if (!open) closeAdd() }}>
      <Dialog.Portal><Dialog.Backdrop /><Dialog.Viewport><Dialog.Popup>
        <Dialog.Title>存密码</Dialog.Title>
        <Dialog.Description>只用于这个网站，每次使用都由你批准。</Dialog.Description>
        <form className="flex flex-col gap-4" onSubmit={event => {
          event.preventDefault()
          void run({ type: 'save', origin, account, password }).then(saved => { setPassword(''); if (saved) closeAdd() })
        }}>
          <Field.Root><Field.Label>网站</Field.Label><Field.Input required type="url" value={origin} placeholder="https://example.com" onChange={event => setOrigin(event.target.value)} /></Field.Root>
          <Field.Root><Field.Label>账号</Field.Label><Field.Input required autoComplete="off" value={account} onChange={event => setAccount(event.target.value)} /></Field.Root>
          <Field.Root><Field.Label>密码</Field.Label><Field.Input required type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></Field.Root>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={closeAdd}>取消</Button><Button type="submit" disabled={busy}>保存</Button></div>
        </form>
      </Dialog.Popup></Dialog.Viewport></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={!!setup} onOpenChange={open => { if (!open) setSetup(undefined) }}>
      <Dialog.Portal><Dialog.Backdrop /><Dialog.Viewport><Dialog.Popup>
        <Dialog.Title>保存恢复材料</Dialog.Title><Dialog.Description>请抄下并妥善保存。忘记本机解锁方式时，需要它恢复密码。</Dialog.Description>
        <p className="break-all select-text rounded border border-[var(--border)] p-3">{setup?.recoveryMaterial}</p>
        <Button disabled={busy || !setup} onClick={() => {
          if (setup) void run({ type: 'confirm-setup', setupId: setup.setupId, material: setup.recoveryMaterial }).then(ok => { if (ok) setSetup(undefined) })
        }}>我已保存，继续</Button>
      </Dialog.Popup></Dialog.Viewport></Dialog.Portal>
    </Dialog.Root>
  </SettingsPage>
}
