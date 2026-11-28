import { useState } from 'react'
import type { ServerSshInstallFailure } from '../../../lib/serverSshInstall'
import { platform } from '../../../platform'
import { useToast } from '../../toastContext'
import { messageForUser } from '../../../lib/userFacingError'
import { InlineAction } from './InlineAction'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/cn'
import { knownHostsRemoveCommand } from './addServerFormat'

// #6264 这台机器的指纹和上次记下的不一样:这是拒绝,不是提问 —— ❌ 问「要不要信任」。
// 说清为什么停、它现在的指纹、删掉旧记录的那条命令(复制去终端执行)。添加机器的失败卡片与直连终端共用。

const text = 'text-[length:var(--font-body)] leading-[1.5]'
const caption = 'text-[length:var(--font-caption)] leading-[1.5]'

type Identity = NonNullable<ServerSshInstallFailure['hostKey']>

export function SshIdentityDetails({ hostKey }: { hostKey: Identity }) {
  const { t } = useTranslation('settings')
  const { toast } = useToast()
  const [copied, setCopied] = useState<string | null>(null)
  const fingerprint = hostKey.fingerprint
  const command = hostKey.host && fingerprint ? knownHostsRemoveCommand(hostKey.host, hostKey.location) : null
  function copy(value: string) {
    void platform.writeClipboardText(value).then(() => setCopied(value),
      error => toast(t('actions.copyFailed', { ns: 'common' }), 'error', messageForUser(error)))
  }
  return <span className="block break-all select-all">
    {hostKey.host && <span className="block">{hostKey.host}</span>}
    {fingerprint && <span className="block">{t('devices.addServer.newFingerprint', { fingerprint })}{' '}
      <InlineAction onClick={() => copy(fingerprint)}>{t(copied === fingerprint ? 'devices.addServer.copied' : 'devices.addServer.copy')}</InlineAction>
    </span>}
    {hostKey.location && <span className="block">{t('devices.loginState.sshOldEntry', { location: hostKey.location })}</span>}
    {command && <span className="block" data-testid="ssh-host-key-remove">{t('devices.link.afterVerify')}{' '}
      <code>{command}</code>{' '}
      <InlineAction onClick={() => copy(command)}>{t(copied === command ? 'devices.addServer.copied' : 'devices.addServer.copy')}</InlineAction>
    </span>}
  </span>
}

export function SshHostKeyChanged({
  hostKey,
  explain = false,
}: {
  hostKey: Identity
  /** 带上「为什么停、下一步做什么」那段话(添加机器的失败卡片已经在上面说过了,不带)。 */
  explain?: boolean
}) {
  const { t } = useTranslation('settings')
  return (
    <>
      {explain && <div className={cn(text, 'text-[var(--fg)]')}>{t('devices.addServer.reasons.hostKeyChanged')}</div>}
      <div className={cn(caption, 'text-[var(--muted-fg)]')}><SshIdentityDetails hostKey={hostKey} /></div>
    </>
  )
}
