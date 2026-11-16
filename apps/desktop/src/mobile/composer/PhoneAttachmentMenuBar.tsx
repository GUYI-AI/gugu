import { useTranslation } from 'react-i18next'
import { Paperclip } from '@/lib/icons'
import { PhoneComposerControl, PhoneComposerControlRow } from './PhoneComposerControls'
import { phoneMenuBar } from './phone-menu-bar'

export function PhoneAttachmentMenuBar({ onOpen, disabled = false }: { onOpen?: () => void; disabled?: boolean }) {
  const { t } = useTranslation('messaging')
  if (!phoneMenuBar('direct', { attachments: !!onOpen }).length) return null
  return <PhoneComposerControlRow><PhoneComposerControl label={t('composer.attachmentsMenu')} icon={<Paperclip />}
    testId="phone-menu-attachments" disabled={disabled} onClick={() => onOpen?.()} /></PhoneComposerControlRow>
}
