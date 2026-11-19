import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { PasswordSyncRequest } from '@gugu/core/shared/passwordBetaProtocol'
import { usePasswordSnapshot, useOpenPasswordDevicePrompt } from '@/lib/passwordBetaNotifications'
import { X } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Sheet } from '../ui/Sheet'
import { SettingsNote } from '../settings/SettingsPrimitives'
import { promptedRequests, usePasswordCommand } from './passwordModel'
import { Code, RecoverSheet, RecoveryCodeSheet } from './passwordSheets'

const name = (request: PasswordSyncRequest) => request.label || '新设备'

/**
 * The key to the passwords travels when a device joins the account, not from a settings page. On a device that already
 * has the passwords, a newly signed-in one asks here; on the new one, the same digits show in a corner card that blocks
 * nothing. Either can be put aside; the notification list brings it back. Mounted once, above the whole signed-in app.
 */
export function PasswordDeviceHost() {
  const snapshot = usePasswordSnapshot()
  const { busy, error, run, clear } = usePasswordCommand()
  const [aside, setAside] = useState<ReadonlySet<string>>(new Set())
  const [cardClosed, setCardClosed] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [newCode, setNewCode] = useState<string>()
  useOpenPasswordDevicePrompt(useCallback((deviceId: string | null) => {
    if (deviceId) setAside(previous => new Set([...previous].filter(id => id !== deviceId)))
    else setCardClosed(false)
  }, []))
  if (!PASSWORD_BETA_ENABLED) return null
  const sync = snapshot?.sync
  const request = promptedRequests(sync).find(entry => !aside.has(entry.deviceId))
  const joining = sync?.state === 'joining' || sync?.state === 'blocked' || sync?.state === 'refused' ? sync : undefined
  const putAside = (deviceId: string) => { clear(); setAside(previous => new Set([...previous, deviceId])) }
  return <>
    {request && <Sheet onClose={() => putAside(request.deviceId)} desktopWidth="380px" mobileFitContent ariaLabel="新设备请求使用密码" testId="password-device-prompt" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 px-5 pb-5 pt-6" data-stage={request.stage}>
        <h2 className="text-[length:var(--font-title)] font-semibold text-[var(--fg)] [overflow-wrap:anywhere]">允许「{name(request)}」用你的密码吗？</h2>
        {request.stage === 'mismatch'
          ? <p className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">这台设备没通过核对，不能允许。</p>
          : <>
            <p className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">它刚登录了你的账号。它的屏幕上也显示这串数字，一致再点允许。</p>
            <div className="flex justify-center rounded-[var(--radius-control)] bg-[var(--muted)] py-3" data-testid="password-device-code">
              {request.code ? <Code value={request.code} /> : <span className="font-mono text-[length:var(--font-title)] tracking-[0.2em] text-[var(--muted-fg)]" aria-label="验证码生成中">··· ···</span>}
            </div>
          </>}
        {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
        {request.stage !== 'mismatch' && <Button variant="primary" size="lg" disabled={busy || request.stage !== 'compare'} data-testid="password-device-allow"
          onClick={() => { void run({ type: 'sync-approve', deviceId: request.deviceId }) }}>允许</Button>}
        <Button variant="ghost" size="lg" disabled={busy} data-testid="password-device-deny"
          onClick={() => { void run({ type: 'sync-reject', deviceId: request.deviceId }) }}>{request.stage === 'mismatch' ? '拒绝' : '不是我'}</Button>
      </div>
    </Sheet>}
    {/* At the document root, like the sheets: a freshly signed-in device is usually still in the first-run guide,
        which keeps the app mounted but not rendered. */}
    {joining && !cardClosed && createPortal(<div role="status" data-testid="password-join-card"
      className="fixed right-4 top-12 z-[var(--z-banner)] flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-2 rounded-[var(--radius-surface)] bg-[var(--menu-bg)] p-4 text-[var(--menu-fg)] shadow-[var(--shadow-lift)]">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-[length:var(--font-body)] font-semibold">{joining.state === 'refused' ? '另一台设备拒绝了这台电脑用你的密码' : '在另一台设备上允许这台电脑用你的密码'}</div>
        <IconButton size="sm" aria-label="关闭" onClick={() => setCardClosed(true)}><X size={14} /></IconButton>
      </div>
      {joining.state === 'refused'
        ? <><div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">点错了的话，可以重新申请。</div>
          {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
          <Button size="sm" className="self-start" disabled={busy} data-testid="password-join-again" onClick={() => { void run({ type: 'sync-ask-again' }) }}>重新申请</Button></>
        : joining.state === 'joining' && joining.code
          ? <><Code value={joining.code} /><div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">两边数字一致，就在那台设备上点允许。</div></>
          : <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">打开你另一台设备上的咕咕，那里会弹出提示。</div>}
      {joining.recovery && <Button variant="ghost" size="sm" className="self-start" onClick={() => { clear(); setRecovering(true) }}>另一台设备都不在了？用恢复码</Button>}
    </div>, document.body)}
    {recovering && <RecoverSheet busy={busy} error={error} onClose={() => setRecovering(false)}
      onSubmit={async code => { const reply = await run({ type: 'sync-recover', code }); if (reply?.recoveryCode) { setRecovering(false); setNewCode(reply.recoveryCode) } }} />}
    {newCode && <RecoveryCodeSheet code={newCode} fresh onClose={() => setNewCode(undefined)} />}
  </>
}
