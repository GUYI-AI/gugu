import { useTranslation } from 'react-i18next'
import { Paperclip } from '@/lib/icons'
import { PhoneComposerControl, PhoneComposerControlRow } from './PhoneComposerControls'
import { phoneMenuBar } from './phone-menu-bar'

export function PhoneAttachmentMenuBar({ onOpen, disabled = false, conversationKey }: { onOpen?: () => void; disabled?: boolean; conversationKey?: string }) {
  const { t } = useTranslation('messaging')
  if (!phoneMenuBar('attachmentOnly', { attachments: !!onOpen }).length) return null
  return <PhoneComposerControlRow conversationKey={conversationKey}><PhoneComposerControl label={t('composer.attachmentsMenu')} icon={<Paperclip />}
    testId="phone-menu-attachments" disabled={disabled} onClick={() => onOpen?.()} /></PhoneComposerControlRow>
}
