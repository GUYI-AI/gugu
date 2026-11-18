import { LiveWindowHeaderIcon } from '@/session/renderer/features/live-window/LiveWindowHeaderIcon'
import type { LiveWindowAction, LiveWindowSnapshot } from '@/session/renderer/features/live-window/types'

export function PhoneLiveWindowTitle({ name, live }: {
  name: string
  live: (LiveWindowSnapshot & { dispatch(action: LiveWindowAction): void }) | null
}) {
  return <span className="gg-aw-title-with-watch"><span className="gg-aw-title-copy">{name}</span>{live && <LiveWindowHeaderIcon snapshot={live} dispatch={live.dispatch} compact />}</span>
}
