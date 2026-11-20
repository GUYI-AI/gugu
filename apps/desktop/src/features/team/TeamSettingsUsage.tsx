import { useState } from 'react'
import { TeamUsage, TeamPauseState } from './TeamUsage'
import { openTeamPage } from './navigation'
import type { TeamStopReason } from './types'

export function TeamSettingsUsage() {
  const [reason, setReason] = useState<TeamStopReason | null>(null)
  return reason ? <TeamPauseState reason={reason} onUsage={() => setReason(null)} onContact={() => openTeamPage('directory')} />
    : <TeamUsage onPause={setReason} />
}
