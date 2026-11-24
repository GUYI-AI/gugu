import { AlertTriangle, Download } from '@/lib/icons'
import { Hint } from './ui/Tooltip'
import { IconButton } from './ui/IconButton'
import './UpdateRailButton.css'

/** 桌面更新提示落在栏底；状态和动作仍由唯一挂载的 UpdateBanner 管。 */
export function UpdateRailButton({ label, description, progress, busy, failed, onClick }: {
  label: string
  description: string
  progress?: number | null
  busy: boolean
  failed: boolean
  onClick?: () => void
}) {
  return (
    <Hint label={description ? `${label}: ${description}` : label}>
      <IconButton
        className="gg-update-rail"
        aria-label={label}
        aria-disabled={busy || !onClick || undefined}
        aria-busy={busy || undefined}
        data-failed={failed || undefined}
        onClick={busy ? undefined : onClick}
      >
        {failed ? <AlertTriangle aria-hidden="true" /> : <Download aria-hidden="true" />}
        {progress !== undefined && (
          <span
            className="gg-update-rail-progress"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
          >
            {progress === null ? '…' : `${Math.round(progress)}%`}
          </span>
        )}
      </IconButton>
    </Hint>
  )
}
