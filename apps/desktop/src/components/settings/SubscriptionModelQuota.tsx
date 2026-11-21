import type { ReactNode } from 'react'
import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins'
import { Meter as MeterPrimitive } from '@base-ui/react/meter'
import { Tooltip } from '@/components/ui/Tooltip'
import { useQuotaWindows } from './subscription-quota-windows'
import { formatPercent, windowLabel } from '@renderer/features/settings/subscriptions/subscription-view'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { remainingUsagePercent, type SubscriptionUsageProvider } from '../usage/subscriptionUsagePresentation'
import './SubscriptionModelQuota.css'

function Meter({ window, compact = false }: { window: SubscriptionUsageWindow; compact?: boolean }) {
  const { translate } = useSessionMessages()
  const remaining = remainingUsagePercent(window)!
  const label = windowLabel(window, translate)
  const value = translate('subscriptions.remainingPercent', { percent: formatPercent(remaining) })
  return <div className={compact ? 'gg-model-quota-window' : 'gg-model-quota-detail'} data-window-minutes={compact ? window.windowMinutes : undefined}>
    <span className="gg-model-quota-label">{label}</span>
    <MeterPrimitive.Root className="gg-model-quota-track" value={remaining} min={0} max={100} aria-label={label} aria-valuetext={value}>
      <MeterPrimitive.Indicator render={<span />} />
    </MeterPrimitive.Root>
    <span className="gg-model-quota-value">{value}</span>
  </div>
}

/** This observes the exact reading used by connection menus and the rail usage popup. */
export function SubscriptionModelQuota({ machine, provider, connectionId, account, enabled, plan, inlineOnly = false, children }: {
  machine: string | null; provider: SubscriptionUsageProvider; connectionId: string; account: string; enabled: boolean; plan?: string; inlineOnly?: boolean; children?: ReactNode;
}) {
  const { translate, locale } = useSessionMessages()
  const { query, reading, windows } = useQuotaWindows(machine, provider, connectionId, enabled)
  if (!windows.length && !children) return null
  const date = (at: number) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at)
  const updated = reading ? translate('subscriptions.usageAsOf', { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(reading.readAt) }) : null
  const inline = <div tabIndex={inlineOnly ? undefined : 0} className="gg-model-quota gg-model-quota-colors" data-usage-provider={provider} data-testid={`model-quota-${connectionId}`} aria-label={provider === 'claude' ? 'Claude' : 'ChatGPT'}>
    {windows.map(window => <Meter key={window.windowMinutes} window={window} compact />)}
  </div>
  if (inlineOnly) return inline
  return <Tooltip.Root>
    <Tooltip.Trigger render={<div className={children ? 'gg-model-subscription-row' : undefined} tabIndex={children ? 0 : undefined} />}>
      {children ?? inline}
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner side="bottom" align="end" sideOffset={10} className="z-[var(--z-settings-modal)]">
      <Tooltip.Popup className="gg-model-quota-popup gg-model-quota-colors" data-usage-provider={provider}>
        <div className="gg-model-quota-heading"><strong>{plan || (provider === 'claude' ? 'Claude' : 'ChatGPT')}</strong><span>{account}</span></div>
        {updated && <div className="gg-model-quota-updated">{updated}</div>}
        {windows.map(window => <div className="gg-model-quota-detail-window" key={window.windowMinutes}>
          <Meter window={window} />
          {window.resetsAt !== undefined && Number.isFinite(window.resetsAt) && <div className="gg-model-quota-reset">{translate('subscriptions.resets', { time: date(window.resetsAt) })}</div>}
        </div>)}
        {(query.error || reading?.kind === 'windows' && reading.refreshError) && <div className="gg-model-quota-error">{translate('subscriptions.payer.unknown')}</div>}
      </Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>
}
