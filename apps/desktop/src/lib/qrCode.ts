import QRCode from 'qrcode'
import { qrColors } from './qrColors'
import { readModel, useReadModel, type Reading } from './readModel'

/** A drawn QR code: the same text at the same width in the same palette is drawn once, and shown at once on the next open. */
const qrCodes = readModel({
  name: 'qrCode',
  scope: 'device',
  read: (_device, value: string, width: number, colors: string) =>
    QRCode.toDataURL(value, { width, margin: 1, color: JSON.parse(colors) as ReturnType<typeof qrColors> }),
  fresh: Infinity,
  keep: 30 * 60_000,
})

/** A QR code image for `value`, `width` px wide (null = nothing to draw). */
export function useQrCode(value: string | null, width: number): Reading<string> {
  return useReadModel(qrCodes, value ? [value, width, JSON.stringify(qrColors())] : null)
}

