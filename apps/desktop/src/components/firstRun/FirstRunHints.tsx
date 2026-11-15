import './first-run-hints.css'
import '../../i18n/registerAssistantCatalog'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useMobileShell } from '@/hooks/useMobileShell'
import { allFirstRunHintsDismissed, dismissFirstRunHints, parseFirstRunHints, type FirstRunHintId } from '@/lib/firstRunHints'
import { useOwnUserSetting } from '@/lib/ownSettings'
import { queryClient } from '@/lib/replica'
import { rendererLogger } from '@/lib/log'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { HINT_ENTRIES, deviceHintsDismissed, useFirstRunHintTargets } from './firstRunHintTargets'

const log = rendererLogger('first-run/hints')
const saveRetry = { retry: 3, retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000) }

/** One quiet, contextual hint at a time. Account reads/writes must succeed before claiming progress. */
export function FirstRunHints({ userId }: { userId: string }) {
  const { t } = useTranslation('assistant')
  const device = useMobileShell() ? 'phone' : 'desktop'
  // The account's `user` row (shared with the product tour). A failed read shows no hint this time (an error reading).
  const progress = useOwnUserSetting(userId, parseFirstRunHints)
  const read = progress.state === 'value' ? progress.value : null
  const targets = useFirstRunHintTargets(device, read !== null && !deviceHintsDismissed(device, read))
  const [pending, setPending] = useState<FirstRunHintId[]>([])
  // Retire the current encounter, not every hint currently on screen in a chain.
  // Another hint can appear when its entry is encountered on a later page/visit.
  const suppressed = useRef(new Set<HTMLElement>())
  for (const anchor of suppressed.current) if (!targets.some((target) => target.anchor === anchor)) suppressed.current.delete(anchor)
  const save = useMutation({
    // The saved row lands in the replica (updateOwnSettingsKey), so the progress reading follows by itself.
    mutationFn: (ids: readonly FirstRunHintId[]) => dismissFirstRunHints(userId, ids),
    ...saveRetry,
    onError: (error) => log.warn({ error: String(error) }, 'First-run hint progress save failed'),
    onSuccess: (next) => setPending((ids) => ids.filter((id) => !next.dismissed.includes(id))),
  }, queryClient)
  const unsaved = pending.filter((id) => !read?.dismissed.includes(id))
  useEffect(() => {
    if (read && unsaved.length && !save.isPending && !save.isError) save.mutate(unsaved)
  }, [read, unsaved, save])

  const retire = (id: FirstRunHintId) => {
    targets.forEach((target) => suppressed.current.add(target.anchor))
    setPending((ids) => ids.includes(id) ? ids : [...ids, id])
  }
  // Capture use even while the account read is pending, and before a pushed page removes its entry.
  useEffect(() => {
    if (progress.state === 'value' && (!progress.value || allFirstRunHintsDismissed(progress.value))) return
    const used = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null
      if (!element || element.closest('[disabled], [aria-disabled="true"]')) return
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ' && !(element.closest('[role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))) return
      const entry = HINT_ENTRIES[device].find((item) => element.closest(item.use))
      if (entry) retire(entry.id)
    }
    document.addEventListener('click', used, true)
    document.addEventListener('keydown', used, true)
    return () => {
      document.removeEventListener('click', used, true)
      document.removeEventListener('keydown', used, true)
    }
  })

  const confirmed = read
  const target = confirmed ? targets.find((item) => !confirmed.dismissed.includes(item.id) && !pending.includes(item.id) && !suppressed.current.has(item.anchor)) : null
  if (!target) return null
  const label = t(`hints.${device}.${target.id}`)
  const note = <>
    <p>{label}</p>
    <Button variant="ghost" size="sm" onClick={() => retire(target.id)} disabled={save.isPending}>
      {t('hints.dismiss')}
    </Button>
  </>
  const testId = `first-run-hint-${target.id}`
  if (target.space) return createPortal(
    <aside className="first-run-hint first-run-hint-inline" aria-label={label} data-testid={testId}>{note}</aside>, target.space,
  )
  if (device !== 'desktop' || target.id !== 'assistant') return null
  return (
    <Popover.Root open modal={false} onOpenChange={(open) => { if (!open) retire(target.id) }}>
      <Popover.Portal>
        <Popover.Positioner anchor={target.anchor} side="right" align="start" sideOffset={8} collisionPadding={16}>
          <Popover.Popup className="first-run-hint" initialFocus={false} finalFocus={false} aria-label={label} data-testid={testId}>{note}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
