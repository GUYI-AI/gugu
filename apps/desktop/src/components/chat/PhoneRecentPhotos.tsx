import { useEffect, useId, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Image } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { queryClient } from '@/lib/replica'
import {
  readRecentPhotoFile, readRecentPhotos, readRecentPhotoThumbnail, recentPhotosAvailable, type RecentPhoto,
} from '@/mobile/phone-device/recentPhotos'
import { useNearViewport } from './useNearViewport'

function RecentPhotoButton({ photo, selected, scope, onClick }: {
  photo: RecentPhoto
  selected: boolean
  scope: string
  onClick: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const visible = useNearViewport(button, true, '0px')
  const { data: thumbnail } = useQuery({
    queryKey: ['phone-attach-thumbnail', scope, photo.version],
    queryFn: () => readRecentPhotoThumbnail(photo),
    enabled: visible,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  }, queryClient)
  return <button ref={button} type="button" className="gg-phone-recent-photo" aria-label={photo.name}
    aria-pressed={selected} onClick={onClick}>
    {thumbnail ? <img src={thumbnail} alt="" /> : <Image aria-hidden />}
    {selected && <span className="gg-phone-recent-check" aria-hidden><Check /></span>}
  </button>
}

export function PhoneRecentPhotos({ selected, onSelect, onRemove }: {
  selected: ReadonlySet<string>
  onSelect: (photo: RecentPhoto, file: File) => void
  onRemove: (photo: RecentPhoto) => void
}) {
  const { t } = useTranslation('messaging')
  const scope = useId()
  const reads = useRef(new Map<string, AbortController>())
  const { data: photos, isFetching } = useQuery({
    queryKey: ['phone-attach-recent-photos', scope],
    queryFn: readRecentPhotos,
    enabled: recentPhotosAvailable(),
    gcTime: 0,
    retry: false,
  }, queryClient)
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

  if (isFetching || !photos?.length) return null
  return <section className="gg-phone-recent-photos" aria-label={t('composer.recentPhotos')}>
    <h3>{t('composer.recentPhotos')}</h3>
    <div className="gg-phone-recent-grid">
      {photos.map(photo => <RecentPhotoButton key={photo.version} scope={scope} photo={photo}
        selected={selected.has(photo.id)} onClick={() => { void toggle(photo) }} />)}
    </div>
  </section>
}
