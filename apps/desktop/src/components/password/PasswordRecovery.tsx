import { useState } from 'react'
import type { PasswordSnapshot } from '@gugu/core/shared/passwordBetaProtocol'
import { usePasswordSnapshot } from '@/lib/passwordBetaNotifications'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { SettingsGroup, SettingsNote, SettingsRow } from '../settings/SettingsPrimitives'
import { Confirm, RecoveryCodeSheet } from './passwordSheets'
import { usePasswordCommand } from './passwordModel'

/** Asked once, right after the first password is kept: the code is the account's own spare key, so it lives in
 * Settings → 账户 afterwards. */
export function RecoveryOffer({ snapshot }: { snapshot?: PasswordSnapshot }) {
  const { busy, error, run } = usePasswordCommand()
  const [shown, setShown] = useState<string>()
  const asking = snapshot?.sync?.state === 'ready' && snapshot.sync.recovery === 'ask' && snapshot.items.length > 0
  return <>
    {asking && !shown && <Sheet onClose={() => { void run({ type: 'sync-recovery-skip' }) }} desktopWidth="400px" mobileFitContent ariaLabel="生成恢复码" testId="password-recovery-offer" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">生成恢复码？</div>
        <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">所有设备都丢了时，在新设备上登录并输入它，就能找回这些密码。以后也可以在 设置 → 账户 里生成。</div>
        {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={busy} onClick={() => { void run({ type: 'sync-recovery-skip' }) }}>以后再说</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void run({ type: 'sync-recovery-create' }).then(reply => { if (reply?.recoveryCode) setShown(reply.recoveryCode) }) }}>生成</Button>
        </div>
      </div>
    </Sheet>}
    {shown && <RecoveryCodeSheet code={shown} onClose={() => setShown(undefined)} />}
  </>
}

/** Settings → 账户: the recovery code belongs to the account, not to one device. Shown once a password is synced here. */
export function PasswordRecoveryGroup() {
  const snapshot = usePasswordSnapshot()
  const { busy, error, run } = usePasswordCommand()
  const [asking, setAsking] = useState<'regenerate' | 'drop'>()
  const [shown, setShown] = useState<{ code: string; fresh: boolean }>()
  const sync = snapshot?.sync
  if (sync?.state !== 'ready') return null
  const create = async (fresh: boolean) => { const reply = await run({ type: 'sync-recovery-create' }); setAsking(undefined); if (reply?.recoveryCode) setShown({ code: reply.recoveryCode, fresh }) }
  const set = sync.recovery === 'set'
  return <>
    <SettingsGroup title="密码恢复码" footer={error ? <SettingsNote tone="danger" role="alert">{error}</SettingsNote> : undefined}>
      <SettingsRow title="恢复码" description={set ? '所有设备都丢了时，在新设备上登录并输入它，就能找回密码。' : '未设置。所有设备都丢了时，就找不回密码。'}
        control={set
          ? <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('regenerate')}>重新生成</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('drop')}>移除</Button></div>
          : <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void create(false) }}>生成</Button>} />
    </SettingsGroup>
    {asking === 'regenerate' && <Confirm title="重新生成恢复码？" action="重新生成" busy={busy} testId="password-recovery-regenerate"
      body="旧的恢复码会立刻失效，手上那份要换成新的。" onClose={() => setAsking(undefined)} onConfirm={() => { void create(true) }} />}
    {asking === 'drop' && <Confirm title="移除恢复码？" action="移除" busy={busy} testId="password-recovery-remove"
      body="移除后，所有设备都丢了就找不回密码。" onClose={() => setAsking(undefined)}
      onConfirm={() => { void run({ type: 'sync-recovery-remove' }).then(() => setAsking(undefined)) }} />}
    {shown && <RecoveryCodeSheet code={shown.code} fresh={shown.fresh} onClose={() => setShown(undefined)} />}
  </>
}
