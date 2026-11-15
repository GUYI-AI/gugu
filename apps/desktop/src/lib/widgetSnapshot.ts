import { replica } from './replica'
import { widgetSnapshots } from './widgetSnapshots'

export const widgetSnapshotDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as string)
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

/**
 * The picture last taken of a widget in a theme at a width (a data URL; null: none kept here): a replica of this device's
 * own picture store, account scope (the store keeps only the signed-in account's). Not kept across restarts (each up to
 * 200 KB, WIDGET_SNAPSHOT_MAX_BYTES); a slot mounted again within `keep` has it in its first frame. Its one writer, the
 * capture (extension-view-layer.tsx), puts the new picture here as it stores it.
 */
export const widgetSnapshot = replica({
  name: 'widgetSnapshot',
  scope: 'account',
  read: async (_owner: string, widgetId: string, theme: string, widthBucket: number): Promise<string | null> => {
    const blob = await widgetSnapshots.read(widgetId, theme, widthBucket * 40)
    return blob ? widgetSnapshotDataUrl(blob) : null
  },
  fresh: Infinity,
  keep: 5 * 60_000,
})

