import { useEffect, useState } from 'react'
import { platform } from '@/platform'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Sheet } from '../ui/Sheet'
import { SettingsNote } from '../settings/SettingsPrimitives'

/** Pieces shared by Settings → 密码, Settings → 账户 and the device prompt. */
/** The 6 digits both devices show, grouped 3 + 3 so they are easy to compare aloud. */
export const Code = ({ value }: { value: string }) => <span className="font-mono text-[length:var(--font-title)] font-semibold tracking-[0.2em] text-[var(--fg)]" aria-label={`验证码 ${value.split('').join(' ')}`}>
  {value.slice(0, 3)} {value.slice(3)}</span>
/** A small confirm sheet in the same shape as the credential delete confirm. */
export function Confirm({ title, body, action, busy, onConfirm, onClose, testId }: { title: string; body: string; action: string; busy: boolean; onConfirm(): void; onClose(): void; testId: string }) {
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
export function RecoveryCodeSheet({ code, fresh, onClose }: { code: string; fresh?: boolean; onClose(): void }) {
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
        <Button size="sm" onClick={() => { void platform.writeClipboardText(code).then(() => setCopied(true), () => {}) }}>{copied ? '已复制' : '复制'}</Button>
        <Button size="sm" variant="primary" onClick={onClose}>我已保存</Button>
      </div>
    </div>
  </Sheet>
}
export function RecoverSheet({ busy, error, onSubmit, onClose }: { busy: boolean; error: string; onSubmit(code: string): Promise<void>; onClose(): void }) {
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
