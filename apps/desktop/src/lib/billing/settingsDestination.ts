import { readMobileShell } from '../../hooks/useMobileShell'
import { UI_EVENTS } from '../uiEvents'
import { readSelfIdentityBridge } from '../selfIdentityBridge'
import { openTeamPage } from '@/features/team/navigation'

/** 购买入口跟随积分卡:桌面订阅、手机账户;用量只查看统计。 */
export function membershipSettingsSection(mobile = readMobileShell()): 'account' | 'subscriptions' {
  return mobile ? 'account' : 'subscriptions'
}

/** Keep conversation links on the same real credit-card destination as account settings. */
export function openCreditSettings(): void {
  const account = readSelfIdentityBridge()?.getSnapshot()
  if (account?.accountKind && account.accountKind !== 'personal') { openTeamPage('usage'); return }
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: membershipSettingsSection() } }))
}
