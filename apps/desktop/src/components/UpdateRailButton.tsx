import { AlertTriangle, Download } from '@/lib/icons'
import { Hint } from './ui/Tooltip'
import { IconButton } from './ui/IconButton'
import './UpdateRailButton.css'

const R = 12, CIRCUMFERENCE = 2 * Math.PI * R

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
        data-progress={progress !== undefined || undefined}
        onClick={busy ? undefined : onClick}
      >
        {failed ? <AlertTriangle aria-hidden="true" /> : <Download aria-hidden="true" />}
        {/* Downloading: a ring round the glyph that fills with rough progress, no number to squeeze the name (owner 11-25). */}
        {progress !== undefined && (
          <svg
            className="gg-update-rail-progress"
            viewBox="0 0 28 28"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
          >
            <circle cx="14" cy="14" r={R} fill="none" stroke="var(--border)" strokeWidth="2" />
            {progress !== null && (
              <circle cx="14" cy="14" r={R} fill="none" stroke="var(--live)" strokeWidth="2" strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, progress)) / 100)}
                transform="rotate(-90 14 14)" />
            )}
          </svg>
        )}
      </IconButton>
    </Hint>
  )
}
