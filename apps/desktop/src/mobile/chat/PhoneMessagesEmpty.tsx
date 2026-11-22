import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { Illustration } from '@/components/ui/Illustration'

export function PhoneMessagesEmpty({ action }: { action?: ReactNode }) {
  const { t } = useTranslation('messaging')
  return <PaneEmptyState art={<Illustration name="no-messages" className="w-[104px]" />} caption={t('chatArea.mobileEmpty.title')} hint={t('chatArea.mobileEmpty.hint')} action={action} />
}
