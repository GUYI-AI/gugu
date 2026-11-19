import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { PhoneSheetHandle } from '../PhoneSheetHandle'
import { Check } from '@/lib/icons'

export type PhoneMarketInstallRow = {
  id: string
  name: string
  status?: 'offline' | 'checking' | 'unavailable' | 'installed' | 'update'
  install?: () => Promise<boolean>
}

export function PhoneMarketInstallSummary({ rows }: { rows: readonly (PhoneMarketInstallRow & { present: boolean })[] }) {
  const { t, i18n } = useTranslation('main')
  const installed = rows.filter(row => row.present).map(row => row.name)
  const updates = rows.filter(row => row.status === 'update').map(row => row.name)
  if (!installed.length) return null
  const list = new Intl.ListFormat(i18n.language)
  return <p className="phone-market-target-summary" role="status">
    {t('phoneMarket.installedOn', { devices: list.format(installed) })}
    {updates.length > 0 ? ` · ${t('phoneMarket.updateOn', { devices: list.format(updates) })}` : null}
  </p>
}

export function PhoneMarketInstallSheet({ rows, onClose }: {
  rows: readonly PhoneMarketInstallRow[]
  onClose(): void
}) {
  const { t } = useTranslation('main')
  const titleId = useId()
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, 'installed' | 'failed'>>({})
  const busy = useRef(false)
  const ordered = [...rows].sort((a, b) => Number(!!b.install) - Number(!!a.install) || Number(b.status === 'installed') - Number(a.status === 'installed'))
  const chosen = rows.filter(row => row.install && selected.has(row.id))
  const close = () => { if (!busy.current) onClose() }
  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const install = async () => {
    if (busy.current || !chosen.length) return
    busy.current = true
    let complete = true
    try {
      for (const row of chosen) {
        setRunning(row.id)
        let ok = false
        try { ok = await row.install?.() === true } catch { /* The device remains selected for retry. */ }
        setResults(current => ({ ...current, [row.id]: ok ? 'installed' : 'failed' }))
        if (ok) setSelected(current => new Set([...current].filter(id => id !== row.id)))
        else complete = false
      }
    } finally {
      busy.current = false
      setRunning(null)
    }
    if (complete) onClose()
  }
  return <Sheet onClose={close} closeOnBackdrop={!running} mobileFitContent titleId={titleId} testId="phone-market-install-sheet">
    <div className="phone-market-install-sheet">
      <PhoneSheetHandle onDismiss={close} disabled={!!running} />
      <h2 id={titleId}>{t('phoneMarket.chooseComputers')}</h2>
      <div className="phone-market-install-devices" role="group" aria-labelledby={titleId}>
        {ordered.map(row => {
          const installed = row.status === 'installed' || results[row.id] === 'installed'
          const checked = installed || selected.has(row.id)
          const state = running === row.id ? 'installing' : results[row.id] ?? row.status
          return <Button key={row.id} role="checkbox" aria-checked={checked} variant="ghost"
            className="phone-market-install-device" disabled={!!running || !row.install || installed}
            data-testid={`phone-market-install-device-${row.id}`} onClick={() => toggle(row.id)}>
            <span className="phone-market-check" data-checked={checked || undefined} aria-hidden>
              {checked && <Check size={14} />}
            </span>
            <span className="phone-market-install-name">{row.name}</span>
            {state && <span className="phone-market-status">{t(`phoneMarket.deviceState.${state}`)}</span>}
          </Button>
        })}
        {!rows.length && <p className="phone-market-status">{t('phoneMarket.noComputers')}</p>}
      </div>
      <Button variant="primary" className="phone-market-install-submit" onClick={() => void install()}
        disabled={!chosen.length || !!running} data-testid="phone-market-install-confirm">
        {t('phoneMarket.install')}
      </Button>
    </div>
  </Sheet>
}
