import { useTranslation } from 'react-i18next'
import { useAttachmentUploadProgress } from '../../lib/attachmentUploadProgress'
import './attachmentUploadOverlay.css'

const R = 15, CIRCUMFERENCE = 2 * Math.PI * R

/**
 * The sender's own attachment while its bytes go up behind the delivered message (owner 11-15): a ring over the picture
 * that fills as they go, gone once they are up; failed, a mark that uploads them again. Only the attachment's state —
 * the message's delivery and reads are the receipt slot's.
 */
export function AttachmentUploadOverlay({ messageId }: { messageId: string }) {
  const { t } = useTranslation('messaging')
  const progress = useAttachmentUploadProgress(messageId)
  if (!progress) return null
  if (progress.failed) {
    const { retry, reason } = progress
    const label = reason ?? t(retry ? 'attachmentView.uploadFailed' : 'attachmentView.senderUploadFailed')
    return <span role={retry ? 'button' : 'img'} tabIndex={retry ? 0 : undefined} aria-label={label}
      title={retry || reason ? label : undefined} data-attachment-upload="failed" className="attachment-upload-overlay"
      onClick={retry && (event => { event.stopPropagation(); retry() })}
      onKeyDown={retry && (event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); retry() } })}>
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="17" fill="var(--danger)" />
        <path d="M18 10v10" stroke="var(--surface-white)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="18" cy="25.5" r="1.8" fill="var(--surface-white)" />
      </svg>
    </span>
  }
  const share = progress.total ? Math.max(0, Math.min(1, progress.loaded / progress.total)) : 0
  return <span role="progressbar" aria-label={t('attachmentView.uploading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(share * 100)}
    data-attachment-upload="uploading" className="attachment-upload-overlay" onClick={event => event.stopPropagation()}>
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" className="attachment-upload-overlay__ring">
      <circle cx="18" cy="18" r={R} fill="none" stroke="var(--surface-white)" strokeOpacity="0.35" strokeWidth="3" />
      <circle cx="18" cy="18" r={R} fill="none" stroke="var(--surface-white)" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - Math.max(share, 0.04))} transform="rotate(-90 18 18)" />
    </svg>
  </span>
}
