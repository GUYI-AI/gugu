import { QrCode } from '@/lib/icons'
import { messageForUser } from '@/lib/userFacingError'
import { useQrCode } from '../lib/qrCode'

/** A QR code on QR paper: a placeholder while it is drawn, the reason if it cannot be. */
export function QrImage({ value, size, alt }: { value: string; size: number; alt: string }) {
  // Drawn at twice the displayed size so it stays sharp on high-density screens.
  const qr = useQrCode(value, size * 2)
  return (
    <div className="grid shrink-0 place-items-center overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--qr-paper)] !p-2">
      <div className="grid place-items-center" style={{ width: size, height: size }}>
        {qr.state === 'value' ? <img src={qr.value} alt={alt} className="block h-full w-full" />
          : qr.state === 'error' ? <p role="alert" className="!m-0 !p-4 text-center text-[length:var(--font-caption)] text-[var(--danger-fg)]">{messageForUser(qr.error)}</p>
          : <QrCode size={42} className="text-[var(--text-tertiary)]" aria-hidden />}
      </div>
    </div>
  )
}
