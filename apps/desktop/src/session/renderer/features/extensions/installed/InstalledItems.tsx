import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Check, LayoutGrid, ListFilter, X } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Sheet } from '@/components/ui/Sheet'
import { Switch } from '@/components/ui/Switch'
import { SearchInput } from '@renderer/lib/ui/search-input'
import type { InstalledItem, InstalledSection } from './installed-item'

export type InventoryView = 'grid' | 'list'
const sections: readonly InstalledSection[] = ['agents', 'apps', 'connectors']

function ItemTile({ item, layout, selected, managing, onSelect }: {
  item: InstalledItem; layout: InventoryView; selected: boolean; managing: boolean; onSelect: () => void
}) {
  const { t } = useTranslation('main')
  const grid = layout === 'grid'
  return (
    <div className="gg-installed-item" data-grid={grid || undefined} data-managing={managing || undefined}>
      <Button className="gg-installed-entry" variant="ghost" disabled={item.busy || (!managing && !item.open)}
        aria-pressed={managing ? selected : undefined} onClick={managing ? onSelect : item.open}>
        <span className="gg-installed-icon">
          {item.icon(grid ? 62 : 36)}
          {grid && managing ? (
            <span className="gg-installed-selection" data-selected={selected || undefined} aria-hidden>{selected && <Check size={12} />}</span>
          ) : grid && item.update ? (
            <span className="gg-installed-update-indicator" aria-label={t('installedManager.updateAvailable')}><ArrowUp size={12} /></span>
          ) : null}
        </span>
        <span className="gg-installed-item-text">
          <span className="gg-installed-item-name" title={item.name}>{item.name}</span>
          {!grid && !!item.version && <span className="gg-installed-version">{item.version}</span>}
        </span>
        {!grid && managing && <span className="gg-installed-selection" data-selected={selected || undefined} aria-hidden>{selected && <Check size={12} />}</span>}
      </Button>
      {!grid && !managing && (
        <div className="gg-installed-actions">
          {item.busy && <LoadingIndicator size="inline" />}
          {item.update && <Button size="sm" variant="secondary" disabled={item.busy} onClick={() => { void item.update?.() }}>{t('installedManager.update')}</Button>}
          {item.setEnabled && (
            <Switch checked={item.enabled === true} aria-label={item.name} disabled={item.busy}
              onCheckedChange={(value) => { void item.setEnabled?.(value) }} />
          )}
        </div>
      )}
    </div>
  )
}

export function InstalledItems({ items, loading, error, offline, section, layout, setSection, setLayout, remoteLabel }: {
  items: readonly InstalledItem[]
  loading?: boolean
  error?: boolean
  offline?: boolean
  section: InstalledSection
  layout: InventoryView
  setSection: (next: InstalledSection) => void
  setLayout: (next: InventoryView) => void
  remoteLabel?: string
}) {
  const { t } = useTranslation('main')
  const panelId = useId()
  const [query, setQuery] = useState('')
  const [managing, setManaging] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const busyRef = useRef(false)
  const shown = items.filter(({ name }) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const picked = shown.filter(({ id }) => selected.has(id))
  const updateable = picked.filter((item) => item.update && !item.busy)
  const removable = picked.filter((item) => item.remove && !item.busy)
  const allSelected = shown.length > 0 && picked.length === shown.length
  const phrase = t(`installedManager.names.${section}`)
  const searchLabel = remoteLabel ? t('installedManager.searchRemote', { device: remoteLabel, section: phrase })
    : t('installedManager.searchLocal', { section: phrase })

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  async function batch(action: 'update' | 'remove', targets: readonly InstalledItem[]) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setConfirming(false)
    const completed: string[] = []
    try {
      for (const item of targets) {
        try {
          await item[action]?.()
          completed.push(item.id)
        } catch { /* Preserve the selection for operations that need another try. */ }
      }
      setSelected((current) => new Set([...current].filter((id) => !completed.includes(id))))
      if (completed.length < targets.length) {
        notify({ tier: 'error', title: t('installedManager.batchFailed', { count: targets.length - completed.length }) })
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <section className="gg-installed-inventory">
      <div className="gg-installed-bar">
        <SegmentedTabs<InstalledSection> ariaLabel={t('installedManager.title')} value={section} onChange={setSection}
          items={sections.map((value) => ({ value, label: t(`installedManager.section.${value}`), panelId }))} />
        <div className="gg-installed-tools">
          {!managing && <Button size="sm" variant="secondary" disabled={offline || loading || error || items.length === 0}
            onClick={() => { setQuery(''); setManaging(true) }}>{t('installedManager.manage')}</Button>}
          <div className="gg-installed-toggle">
            <IconButton aria-label={t('installedManager.grid')} aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid size={16} /></IconButton>
            <IconButton aria-label={t('installedManager.list')} aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><ListFilter size={16} /></IconButton>
          </div>
        </div>
      </div>
      {managing ? (
        <div className="gg-installed-bar">
          <span role="status">{t('installedManager.selected', { count: picked.length })}</span>
          <Button size="sm" variant="ghost" disabled={busy || shown.length === 0}
            onClick={() => setSelected(allSelected ? new Set() : new Set(shown.map(({ id }) => id)))}>
            {t(allSelected ? 'installedManager.clearSelection' : 'installedManager.selectAll')}
          </Button>
          <div className="gg-installed-tools">
            <Button size="sm" variant="secondary" disabled={busy || updateable.length === 0}
              onClick={() => { void batch('update', updateable) }}>{t('installedManager.update')}</Button>
            <Button size="sm" variant="secondary" className="gg-installed-danger" disabled={busy || removable.length === 0}
              onClick={() => setConfirming(true)}>{t('installedManager.remove')}</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { setSelected(new Set()); setManaging(false) }}>
              {t('installedManager.done')}
            </Button>
          </div>
        </div>
      ) : (
        <SearchInput type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={searchLabel} aria-label={searchLabel} disabled={offline || busy} />
      )}
      <div id={panelId} role="tabpanel" aria-label={phrase} className="gg-installed-items">
        {loading ? <div className="gg-installed-empty"><LoadingIndicator size="inline" /></div>
          : offline ? <p className="gg-installed-empty">{t('installedManager.offline')}</p>
          : error ? <p className="gg-installed-empty">{t('installedManager.readFailed')}</p>
          : shown.length === 0 ? <p className="gg-installed-empty">{t(query.trim() ? 'installedManager.noResults' : 'installedManager.empty', { section: phrase })}</p>
          : <div className={layout === 'grid' ? 'gg-installed-grid' : 'gg-installed-list'}>
            {shown.map((item) => <ItemTile key={item.id} item={item} layout={layout} managing={managing}
              selected={selected.has(item.id)} onSelect={() => toggle(item.id)} />)}
          </div>}
      </div>
      {confirming && <Sheet ariaLabel={t('installedManager.removeTitle', { section: phrase })}
        dimNested zIndex="var(--z-settings-modal)" onClose={() => setConfirming(false)}>
        <div className="gg-installed-confirm">
          <div className="gg-installed-bar">
            <h3>{t('installedManager.removeTitle', { section: phrase })}</h3>
            <IconButton aria-label={t('settings.close')} onClick={() => setConfirming(false)}><X size={16} /></IconButton>
          </div>
          <p>{t('installedManager.removeDescription', { count: removable.length, section: phrase, device: remoteLabel ?? t('installedManager.thisComputer') })}</p>
          <div className="gg-installed-tools">
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>{t('installedManager.cancel')}</Button>
            <Button size="sm" variant="danger" onClick={() => { void batch('remove', removable) }}>
              {t('installedManager.confirmRemove')}
            </Button>
          </div>
        </div>
      </Sheet>}
    </section>
  )
}
