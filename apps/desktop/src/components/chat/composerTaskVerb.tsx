import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SquarePen, Zap } from '@/lib/icons'
import { useSidebarChatView } from '../../lib/sidebarChatsBridge'

/**
 * GUYI-AI/gugu#2548 the composer's 「新任务」 (ComposerVerbs). With the desktop sidebar as one list (internal switch
 * `interface.desktopSidebarV2`, published by the task page's sidebar, never on the phone) it reads 「新智能体」 with the
 * pen of 创建智能体: the same action, named as the sidebar names it (mock v33 派智能体).
 */
export function useComposerTaskVerb(): { label: string; icon: ReactNode } {
  const { t } = useTranslation('messaging')
  return useSidebarChatView().oneList === true
    ? { label: t('composer.verb.agent'), icon: <SquarePen size={14} /> }
    : { label: t('composer.verb.task'), icon: <Zap size={14} /> }
}
