import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { QrCode } from '@/lib/icons'
import { messageForUser } from '@/lib/userFacingError'
import { qrColors } from '../lib/qrColors'

/** A QR code on QR paper: a placeholder while it is drawn, the reason if it cannot be. */
export function QrImage({ value, size, alt }: { value: string; size: number; alt: string }) {
  const [qr, setQr] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  useEffect(() => {
    let cancelled = false
    setQr({ url: null, error: null })
    // Drawn at twice the displayed size so it stays sharp on high-density screens.
    QRCode.toDataURL(value, { width: size * 2, margin: 1, color: qrColors() })
      .then((url) => { if (!cancelled) setQr({ url, error: null }) })
      .catch((error: unknown) => { if (!cancelled) setQr({ url: null, error: messageForUser(error) }) })
    return () => { cancelled = true }
  }, [value, size])
  return (
    <div className="grid shrink-0 place-items-center overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--qr-paper)] !p-2">
      <div className="grid place-items-center" style={{ width: size, height: size }}>
        {qr.url ? <img src={qr.url} alt={alt} className="block h-full w-full" />
          : qr.error ? <p role="alert" className="!m-0 !p-4 text-center text-[length:var(--font-caption)] text-[var(--danger-fg)]">{qr.error}</p>
          : <QrCode size={42} className="text-[var(--text-tertiary)]" aria-hidden />}
      </div>
    </div>
  )
}
