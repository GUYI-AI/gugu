import { Capacitor } from '@capacitor/core'
import { nativePhoneData, readPhoneDataStatus } from './phoneDataActions'

const RECENT_PHOTO_LIMIT = 12

export type RecentPhoto = { id: string; name: string; mime_type: string; version: string }

export function recentPhotosAvailable(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('GuguPhoneData')
}

export async function readRecentPhotos(): Promise<RecentPhoto[]> {
  const status = await readPhoneDataStatus()
  if (!status.images && !status.selected) return []
  try {
    const { items } = await nativePhoneData.mediaList({ kind: 'image', limit: RECENT_PHOTO_LIMIT }) as { items: RecentPhoto[] }
    return items
  } catch (error) {
    if ((error as { code?: string }).code === 'os_permission') return []
    throw error
  }
}

export async function readRecentPhotoThumbnail(photo: RecentPhoto): Promise<string | null> {
  const { jpeg } = await nativePhoneData.recentPhotoThumbnail({ id: photo.id })
  return jpeg ? `data:image/jpeg;base64,${jpeg}` : null
}

export async function readRecentPhotoFile(photo: RecentPhoto, signal: AbortSignal): Promise<File> {
  const uri = `content://media/external/images/media/${encodeURIComponent(photo.id)}`
  const response = await fetch(Capacitor.convertFileSrc(uri), { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status} reading selected photo`)
  const blob = await response.blob()
  return new File([blob], photo.name, { type: photo.mime_type || blob.type })
}
