import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { Button } from '@/components/ui/Button'
import { MessageCircle, Search, Users } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { openGlobalSearch } from '@renderer/features/global-search/search-session'
import { tabItemStyle } from './settledTab'
import { PhoneViewportContext, type PhoneViewport } from './usePhoneViewport'

/** 点按切换时挂在栏上的动画窗口:比胶囊那段 400ms 的液态动画多留一点,跑完就摘,❌ 拖动时还挂着(那会拖在手指后面)。 */
const TAB_SWITCH_MS = 460
/** 点按跨过几格(胶囊半路要拉长盖住的格数);CSS 的液态关键帧读它。 */
const TAB_SPAN_VAR = '--gg-tab-span'

const anchorStyle = (height: number, index: number): CSSProperties => ({ '--phone-nav-viewport-height': `${height}px`, '--phone-nav-selected-index': index }) as CSSProperties

/** 编辑时保持原布局锚点，让缩小的可视区/系统键盘盖住底栏；焦点本身不隐藏底栏。 */
function useNavHeight(viewport: PhoneViewport): number {
  const [height, setHeight] = useState(window.innerHeight)
  const width = useRef(window.innerWidth)
  useLayoutEffect(() => {
    const rotated = width.current !== window.innerWidth
    width.current = window.innerWidth
    if (rotated || (!viewport.inputFocused && viewport.keyboardVisible !== true)) setHeight(window.innerHeight)
  }, [viewport.viewportHeight, viewport.inputFocused, viewport.keyboardVisible])
  return height
}

export function PhoneTabBar({ activeTab, onTabChange, pendingContactsCount, barRef, tabs, viewport: suppliedViewport }: {
  activeTab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  pendingContactsCount: number
  barRef: RefObject<HTMLElement | null>
  tabs: readonly SidebarTab[]
  viewport?: PhoneViewport
}) {
  const shellViewport = useContext(PhoneViewportContext)
  const viewport = suppliedViewport ?? shellViewport
  if (!viewport) throw new Error('Phone navigation requires its shell viewport')
  const { t } = useTranslation('main')
  const { t: mt } = useTranslation('messaging')
  const height = useNavHeight(viewport)
  const switchTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(switchTimer.current), [])
  const tapTab = (tab: SidebarTab) => {
    const bar = barRef.current
    const from = tabs.indexOf(activeTab), to = tabs.indexOf(tab)
    if (bar && tab !== activeTab) {
      // 方向决定胶囊哪条边先冲过去(phone-look.css 的液态关键帧,#3310);连点时先摘再挂,让动画从头放。
      bar.removeAttribute('data-tab-switching')
      bar.style.setProperty(TAB_SPAN_VAR, String(from >= 0 && to >= 0 ? Math.abs(to - from) : 1))
      bar.getBoundingClientRect()
      bar.setAttribute('data-tab-switching', to < from ? 'back' : 'forward')
      window.clearTimeout(switchTimer.current)
      switchTimer.current = window.setTimeout(() => bar.removeAttribute('data-tab-switching'), TAB_SWITCH_MS)
    }
    onTabChange(tab)
  }
  const entries = {
    chats: { label: t('shell.messagesMobile'), icon: <MessageCircle />, testId: AUTOMATION_TEST_IDS.mobileMessagesNav },
    contacts: { label: t('shell.partnersMobile'), icon: <Users />, testId: AUTOMATION_TEST_IDS.mobileContactsNav },
  }
  return (
    <nav ref={barRef} data-phone-tabbar="" className="gg-phone-nav" style={anchorStyle(height, tabs.indexOf(activeTab))}>
      <div className="gg-phone-nav-destinations">
        {tabs.map((tab, index) => {
          const item = tab === 'chats' || tab === 'contacts' ? entries[tab] : null
          if (!item) return null
          return <Button key={tab} variant="ghost" className="gg-phone-nav-item" aria-label={item.label} aria-current={tab === activeTab ? 'page' : undefined} data-testid={item.testId} onClick={() => tapTab(tab)} style={tabItemStyle(index, tabs.indexOf(activeTab), 'var(--primary)', 'var(--phone-nav-idle)')}>
            <span className="gg-phone-nav-icon">{item.icon}{tab === 'contacts' && pendingContactsCount > 0 ? <span className="gg-phone-nav-badge">{pendingContactsCount > 99 ? '99+' : pendingContactsCount}</span> : null}</span>
            <span className="gg-phone-nav-label">{item.label}</span>
          </Button>
        })}
      </div>
      <Button variant="ghost" className="gg-phone-nav-search" data-testid="phone-list-search" aria-label={mt('chatList.search')} onPointerDown={(event) => event.preventDefault()} onClick={() => openGlobalSearch()}><Search /></Button>
    </nav>
  )
}
