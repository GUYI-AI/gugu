import type { CSSProperties, ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { ChevronLeft } from '@/lib/icons'
import { DUR_SLOW_MS, EASE_SPRING, tween } from '@/styles/motion'
import { IconButton } from '../ui/IconButton'
import { useBackLayer } from '../ui/sheetStack'
import { rightPanelMobilePageStyle } from './rightPanelMobilePage'

// 聊天区右侧那一个槽位在手机上的外壳(成员列表 / 群设置 / 群公告 / 历史 / 工作区):整页从右边推进来。桌面上这些面板
// 是会话页并排的侧页(PanelTrack)或聊天上的一层(ChatAreaPanel 的 coverChat),不走这里。
const mobileScrollPageStyle: CSSProperties = { ...rightPanelMobilePageStyle, overflow: undefined, overflowY: 'auto' }

/**
 * `scroll`:外壳自己滚动;不给则由内容自带滚动区。
 * `onClose`:安卓返回键先关它(同左上返回);页头自己已经接返回键的(SettingsPageHead)不传。
 */
export function RightPanel({ children, scroll = false, testId, onClose }: { children: ReactNode; scroll?: boolean; testId?: string; onClose?: () => void }) {
  useBackLayer(onClose, true)
  return (
    <motion.div
      data-testid={testId}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={tween(DUR_SLOW_MS, EASE_SPRING)}
      style={scroll ? mobileScrollPageStyle : rightPanelMobilePageStyle}
    >
      {children}
    </motion.div>
  )
}

/** 手机整页的出口:左上返回(#1787 手机导航规范);桌面仍是各面板自己右上的关闭。 */
export function RightPanelBackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('messaging')
  return (
    <IconButton size="lg" aria-label={t('common.back')} title={t('common.back')} onClick={onBack}>
      <ChevronLeft />
    </IconButton>
  )
}
