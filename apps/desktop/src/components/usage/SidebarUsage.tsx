import { useState } from 'react'
import { Meter as MeterPrimitive } from '@base-ui/react/meter'
import { useTranslation } from 'react-i18next'
import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins'
import { useAuth } from '@/store/auth'
import { useSpendingPower, refreshSpendingPower, formatCredits } from '@/lib/billing'
import { BarChart3, Circle, RefreshCw } from '@/lib/icons'
import { UI_EVENTS } from '@/lib/uiEvents'
import { Popover } from '@/components/ui/Popover'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { Hint } from '@/components/ui/Tooltip'
import { Unknown } from '@/components/ui/Unknown'
import { remainingUsagePercent, subscriptionWindow, usageRingGeometry, USAGE_RING_WIDTH, type SubscriptionUsageProvider } from './subscriptionUsagePresentation'
import { useSidebarUsage, type SidebarSubscription } from './useSidebarUsage'
import './SidebarUsage.css'
import './SubscriptionUsageColors.css'

const brand = (provider: SubscriptionUsageProvider) => provider === 'claude' ? 'Claude' : 'ChatGPT'

/** Existing MIT activity-ring geometry; each circumference is a real account's weekly remainder. */
function UsageRings({ rings }: { rings: ReturnType<typeof useSidebarUsage>['rings'] }) {
  const geometry = usageRingGeometry(rings.length)
  return <svg width="22" height="22" viewBox={`0 0 ${geometry.size} ${geometry.size}`} fill="none" aria-hidden="true" className="gg-usage-rings">
    <g transform={`rotate(-90 ${geometry.center} ${geometry.center})`}>
      {rings.map((item, index) => {
        const radius = geometry.radii[index]!
        const remaining = remainingUsagePercent(item.week)!
        const circumference = 2 * Math.PI * radius
        const common = { cx: geometry.center, cy: geometry.center, r: radius }
        return <g key={`${item.provider}:${item.connection.id}`} className="gg-usage-ring gg-model-quota-colors" data-usage-provider={item.provider}>
          <circle {...common} className="gg-usage-ring-track" strokeWidth={USAGE_RING_WIDTH} />
          {remaining > 0 && <>
            <circle {...common} className="gg-usage-ring-edge" strokeWidth={USAGE_RING_WIDTH + 4} strokeDasharray={`${circumference * remaining / 100} ${circumference}`} strokeLinecap="round" />
            <circle {...common} className="gg-usage-ring-fill" strokeWidth={USAGE_RING_WIDTH} strokeDasharray={`${circumference * remaining / 100} ${circumference}`} strokeLinecap="round" />
          </>}
        </g>
      })}
    </g>
  </svg>
}

function UsageWindow({ label, window }: { label: string; window: SubscriptionUsageWindow | undefined }) {
  const { t, i18n } = useTranslation('main')
  const remaining = window ? remainingUsagePercent(window) : null
  const reset = window?.resetsAt !== undefined && Number.isFinite(window.resetsAt)
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(window.resetsAt) : null
  return <div className="gg-usage-metric">
    <div className="gg-usage-metric-label"><span>{label}{window?.group ? ` (${window.group})` : ''}</span>
      {remaining === null ? <span className="gg-usage-muted">{t('usagePopover.windowMissing')}</span> : <span>{t('usagePopover.remaining', { amount: Math.round(remaining) })}</span>}
    </div>
    {remaining !== null && <MeterPrimitive.Root className="gg-usage-track" value={remaining} min={0} max={100} aria-label={label} aria-valuetext={t('usagePopover.remaining', { amount: Math.round(remaining) })}>
      <MeterPrimitive.Indicator render={<span />} />
    </MeterPrimitive.Root>}
    {reset && <div className="gg-usage-meta">{t('usagePopover.reset', { date: reset })}</div>}
  </div>
}

function SubscriptionSection({ item }: { item: SidebarSubscription }) {
  const { t, i18n } = useTranslation('main')
  const details = item.details.state === 'value' ? item.details.value : null
  const status = details?.status
  const usage = item.usage.state === 'value' ? item.usage.value : null
  const failure = item.details.state === 'error' ? item.details.error : item.details.state === 'value' ? item.details.error : null
  const usageFailure = item.usage.state === 'error' ? item.usage.error : item.usage.state === 'value' ? item.usage.error : null
  const account = item.connection.name || (status?.kind === 'authenticated' ? status.account : '')
  let unavailable: string | null = null
  if (failure || usageFailure) unavailable = t('usagePopover.readFailed')
  else if (status?.kind === 'unauthenticated') unavailable = t(status.reason === 'expired' ? 'usagePopover.expired' : 'usagePopover.signedOut')
  else if (status?.kind === 'unknown') unavailable = t('usagePopover.readFailed')
  else if (usage?.kind === 'unavailable') unavailable = t(`usagePopover.reason.${usage.reason}`)
  return <section className="gg-usage-section gg-model-quota-colors" data-usage-provider={item.provider} data-provider={item.provider} data-connection={item.connection.id}>
    <div className="gg-usage-provider"><strong>{brand(item.provider)}</strong><span className="gg-usage-muted">{account}</span></div>
    {usage && <div className="gg-usage-meta">{t('usagePopover.updated', { time: new Intl.DateTimeFormat(i18n.resolvedLanguage, { hour: '2-digit', minute: '2-digit' }).format(usage.readAt) })}</div>}
    {usage?.kind === 'windows' ? <>
      <UsageWindow label={t('usagePopover.fiveHours')} window={subscriptionWindow(usage.windows, 300)} />
      <UsageWindow label={t('usagePopover.weekly')} window={subscriptionWindow(usage.windows, 10_080)} />
      {(usage.refreshError || unavailable) && <p className="gg-usage-error" role="status">{t('usagePopover.refreshFailed')}</p>}
    </> : unavailable ? <p className="gg-usage-muted" role="status">{unavailable}</p> : <Unknown className="h-4 w-full" />}
  </section>
}

export function SidebarUsage() {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const spending = useSpendingPower(user)
  const readings = useSidebarUsage()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    try { await Promise.allSettled([readings.refresh(), refreshSpendingPower()]) }
    finally { setRefreshing(false) }
  }
  const openUsage = () => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'usage' } }))
  }
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) readings.readOnOpen() }}>
    <Hint label={t('usagePopover.title')}>
      <Popover.Trigger type="button" className="gg-sidebar-item" aria-label={t('usagePopover.title')} data-on={open || undefined} data-rail="usage" data-testid="sidebar-usage">
        {readings.rings.length ? <UsageRings rings={readings.rings} /> : readings.pending ? <Unknown className="h-[22px] w-[22px] rounded-full" /> : <Circle size={22} />}
      </Popover.Trigger>
    </Hint>
    <Popover.Portal><Popover.Positioner side="right" align="end" sideOffset={12}>
      <Popover.Popup className="gg-usage-popover" data-testid="usage-popover">
        <header className="gg-usage-header"><Popover.Title>{t('usagePopover.title')}</Popover.Title>
          <IconButton size="sm" aria-label={t('usagePopover.refresh')} disabled={refreshing || readings.refreshing} onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>
        </header>
        <div className="gg-usage-content">
          {readings.subscriptions.map(item => <SubscriptionSection key={`${item.provider}:${item.connection.id}`} item={item} />)}
          {readings.pending && !readings.subscriptions.length && <div className="gg-usage-section"><Unknown className="h-4 w-full" /></div>}
          {readings.failures.map(failure => <div className="gg-usage-section" key={failure.provider}><strong>{brand(failure.provider)}</strong><p role="status" className="gg-usage-error">{t('usagePopover.readFailed')}</p></div>)}
          <section className="gg-usage-section">
            <div className="gg-usage-provider"><strong>{t('usagePopover.guguSubscription')}</strong></div>
            <div className="gg-usage-credit"><span>{t('usagePopover.credits')}</span>
              {!user ? <span className="gg-usage-muted">{t('usagePopover.signedOut')}</span>
                : spending.state === 'unknown' ? <Unknown className="h-6 w-24" />
                  : spending.balance === null ? <span className="gg-usage-muted" role="status">{t('usagePopover.readFailed')}</span>
                    : <strong>{formatCredits(spending.balance)}</strong>}
            </div>
          </section>
        </div>
        <footer className="gg-usage-footer"><Button variant="ghost" onClick={openUsage}><BarChart3 size={16} />{t('usagePopover.fullUsage')}</Button></footer>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>
}
