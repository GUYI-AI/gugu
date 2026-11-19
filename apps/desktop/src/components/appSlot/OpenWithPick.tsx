import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { noteOpenWithDefault, useInstalledApps, type InstalledApps } from '../../session/renderer/features/extensions/installed-extensions'
import { Unknown } from '../ui/Unknown'
import { RefreshFailed } from '../ui/RefreshFailed'
import type { AppOpenWithDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { displayNameOf, openWithKey, type FileOpenerCandidate } from '../../session/shared/extensions/file-openers'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { appsHere } from './appsHere'
import { HERE_HOST } from './hereHost'
import { appNameOf, rememberedOpener } from './openerChoice'

/**
 * 「用哪个打开」 a chat's file (摩擦单 F73), wherever it is asked — beside the chat, in a peek over a page; on the desktop
 * as on the phone: the Apps that claim it, the one kept for its kind marked, and 「始终用它」 keeping the pick (or, unticked
 * where one was kept, keeping none).
 */
type OpenWithPickProps = {
  detail: AppOpenWithDetail & { choice: { kind: 'choose' } }
  onPick: (candidate: FileOpenerCandidate) => void
  onCancel?: () => void
  testId?: string
}

export function OpenWithPick(props: OpenWithPickProps) {
  const installed = useInstalledApps(HERE_HOST)
  // The kept choice is part of what is drawn (its mark, the tick): the chooser waits for the list (❌ drawn unticked first).
  if (installed.state === 'value') return <OpenWithChoices {...props} installed={installed.value} />
  return (
    <div className="flex flex-col gap-3" data-testid={props.testId ?? 'group-app-open-with'}>
      {installed.state === 'error'
        ? <RefreshFailed reading={installed} />
        : <Unknown className="h-24 w-full" />}
    </div>
  )
}

function OpenWithChoices({ detail, onPick, onCancel, testId = 'group-app-open-with', installed }: OpenWithPickProps & { installed: InstalledApps }) {
  const { t } = useTranslation('messaging')
  const key = openWithKey('chat', detail.choice.suffix)
  const kept = rememberedOpener(installed, key)
  const [always, setAlways] = useState(kept !== null)
  const pick = (candidate: FileOpenerCandidate) => {
    const next = always ? candidate.tabKind : kept !== null ? null : undefined
    if (next !== undefined && appsHere && HERE_HOST) {
      // This window's copy too, as the session page's picker does: the next open here reads it (S18 on F73's first run).
      noteOpenWithDefault(HERE_HOST, key, next)
      void appsHere.setOpenWithDefault({ key, tabKind: next })
    }
    onPick(candidate)
  }
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {/* The name as the file list says it (摩擦单 F73 / F39), not the raw one with the suffix it is claimed by. */}
      <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">
        {t('chatArea.openWith.title', { name: displayNameOf(detail.name, detail.choice.suffix) })}
      </div>
      {detail.choice.candidates.map((candidate) => (
        <Button key={candidate.tabKind} variant="secondary" data-open-with={candidate.tabKind} onClick={() => pick(candidate)}>
          <span className="flex flex-col items-start">
            <span className="flex items-center gap-2">
              {appNameOf(candidate, installed.locale)}
              {kept === candidate.tabKind ? <Chip data-testid="group-app-open-with-default">{t('chatArea.openWith.default')}</Chip> : null}
            </span>
            {candidate.onlyTab ? null : <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{candidate.tabTitle}</span>}
          </span>
        </Button>
      ))}
      <label className="flex items-center gap-2 text-[length:var(--font-body)] text-[var(--text-secondary)]">
        <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} data-testid="group-app-open-with-always" />
        {t('chatArea.openWith.always')}
      </label>
      {onCancel ? (
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      ) : null}
    </div>
  )
}
