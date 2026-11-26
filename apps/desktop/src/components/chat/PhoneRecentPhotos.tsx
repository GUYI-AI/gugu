import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Image } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { replica, useReplica, valueOf } from '@/lib/replica'
import {
  readRecentPhotoFile, readRecentPhotos, readRecentPhotoThumbnail, recentPhotosAvailable, type RecentPhoto,
} from '@/mobile/phone-device/recentPhotos'
import { useNearViewport } from './useNearViewport'
import { Button } from '../ui/Button'

const recentList = replica({
  name: 'phone-attach-recent-photos',
  scope: 'device',
  keep: 0,
  read: (_owner, _panel: string) => readRecentPhotos(),
})

const recentThumbnail = replica({
  name: 'phone-attach-thumbnail',
  scope: 'device',
  fresh: Infinity,
  keep: 0,
  read: (_owner, _panel: string, id: string, _version: string) => readRecentPhotoThumbnail(id),
})

function RecentPhotoButton({ photo, selected, scope, onClick }: {
  photo: RecentPhoto
  selected: boolean
  scope: string
  onClick: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const visible = useNearViewport(button, true, '0px')
  const thumbnail = valueOf(useReplica(recentThumbnail, visible ? [scope, photo.id, photo.version] : null))
  return <Button ref={button} variant="ghost" className="gg-phone-recent-photo" aria-label={photo.name}
    aria-pressed={selected} onClick={onClick}>
    {thumbnail ? <img src={thumbnail} alt="" /> : <Image aria-hidden />}
    {selected && <span className="gg-phone-recent-check" aria-hidden><Check /></span>}
  </Button>
}

export function PhoneRecentPhotos({ selected, onSelect, onRemove }: {
  selected: ReadonlySet<string>
  onSelect: (photo: RecentPhoto, file: File) => void
  onRemove: (photo: RecentPhoto) => void
}) {
  const { t } = useTranslation('messaging')
  const scope = useId()
  const reads = useRef(new Map<string, AbortController>())
  const photos = valueOf(useReplica(recentList, recentPhotosAvailable() ? [scope] : null))
  useEffect(() => {
    const inFlight = reads.current
    return () => {
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
    }
  }, [])

  const toggle = async (photo: RecentPhoto) => {
    if (selected.has(photo.id)) {
      onRemove(photo)
      return
    }
    const inFlight = reads.current
    const previous = inFlight.get(photo.id)
    if (previous) {
      previous.abort()
      inFlight.delete(photo.id)
      return
    }
    const controller = new AbortController()
    inFlight.set(photo.id, controller)
    try {
      const file = await readRecentPhotoFile(photo, controller.signal)
      if (!controller.signal.aborted) onSelect(photo, file)
    } catch {
      if (!controller.signal.aborted) notify({ key: 'phone-recent-photo-read-failed', title: t('composer.recentPhotoReadFailed'), tier: 'error' })
    } finally {
      if (inFlight.get(photo.id) === controller) inFlight.delete(photo.id)
    }
  }

  if (!photos?.length) return null
  return <section className="gg-phone-recent-photos" aria-label={t('composer.recentPhotos')}>
    <div className="gg-phone-recent-grid">
      {photos.map(photo => <RecentPhotoButton key={photo.version} scope={scope} photo={photo}
        selected={selected.has(photo.id)} onClick={() => { void toggle(photo) }} />)}
    </div>
  </section>
}
