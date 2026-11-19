import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { MessageCircle } from '@/lib/icons'

export function PhoneMessagesEmpty({ action }: { action?: ReactNode }) {
  const { t } = useTranslation('messaging')
  return <PaneEmptyState phone icon={<MessageCircle size={24} />} caption={t('chatArea.mobileEmpty.title')} hint={t('chatArea.mobileEmpty.hint')} action={action} />
}
