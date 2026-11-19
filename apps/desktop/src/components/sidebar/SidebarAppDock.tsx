import { Fragment, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RailApp } from '../../session/renderer/features/extensions/installed-extensions-store'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { DropdownMenu } from '../ui/Menu'
import { OpenableAppRows } from '../chat/OpenAppMenuItems'
import { railAppVisibleCount } from './railAppCapacity'

interface DockMetrics { height: number; rowHeight: number; gap: number }

/** The rail allocates the space after fixed navigation and before its footer.
 * Read that box, rather than guessing a fraction of the window's height.
 */
export function SidebarAppDock({ apps, children, moreButton, onOpen }: {
  apps: readonly RailApp[]
  children: (app: RailApp) => ReactNode
  moreButton: ReactElement
  onOpen: (appId: string) => void
}) {
  const { t } = useTranslation('main')
  const container = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<DockMetrics | null>(null)
  useLayoutEffect(() => {
    const element = container.current!
    const measure = () => {
      const row = element.querySelector<HTMLElement>('.gg-sidebar-item')
      if (!row) return
      const style = getComputedStyle(element)
      const next = {
        height: element.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0),
        rowHeight: row.getBoundingClientRect().height,
        gap: parseFloat(style.rowGap) || 0,
      }
      setMetrics(previous => previous && previous.height === next.height && previous.rowHeight === next.rowHeight && previous.gap === next.gap ? previous : next)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  // Until layout is known, More is the measurable entry and no App can grow the rail.
  const visibleCount = metrics ? railAppVisibleCount(apps.length, metrics.height, metrics.rowHeight, metrics.gap) : 0
  const overflow = apps.slice(visibleCount)
  return <div ref={container} className="gg-sidebar-dock" data-testid={AUTOMATION_TEST_IDS.sidebarDock}>
    {apps.slice(0, visibleCount).map(app => <Fragment key={app.extensionId}>{children(app)}</Fragment>)}
    {overflow.length > 0 && <DropdownMenu.Root>
      <DropdownMenu.Trigger render={moreButton} />
      <DropdownMenu.Content side="right" align="start" aria-label={t('shell.moreApps')}>
        <OpenableAppRows apps={overflow} onOpen={onOpen} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>}
  </div>
}
