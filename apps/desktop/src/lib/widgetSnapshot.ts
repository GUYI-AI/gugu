import { replica } from './replica'
import { widgetSnapshots } from './widgetSnapshots'

export const widgetSnapshotDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as string)
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

/**
 * The picture last taken of a widget in a theme at a width (data URL; null: none). Not persisted (≤ 200 KB each); a slot
 * remounted within `keep` has it in its first frame. The capture (extension-view-layer.tsx) puts each new picture here.
 */
export const widgetSnapshot = replica({
  name: 'widgetSnapshot',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner: string, widgetId: string, theme: string, widthBucket: number): Promise<string | null> => {
    // The picture store not bound to the account yet: not known, ❌ "no picture" remembered for the entry's life.
    if (!widgetSnapshots.capture()) throw new Error('The widget picture store is not open for this account yet')
    const blob = await widgetSnapshots.read(widgetId, theme, widthBucket * 40)
    return blob ? widgetSnapshotDataUrl(blob) : null
  },
  fresh: Infinity,
  keep: 5 * 60_000,
})

