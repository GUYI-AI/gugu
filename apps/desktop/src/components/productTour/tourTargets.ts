import { useLayoutEffect, useState } from 'react'
import { TOUR_STEPS, type TourStepId } from '../../lib/productTour'
import { readPanelToggle } from '../../lib/panelToggles'
import { isElementVisible } from '@/lib/elementVisibility'

/**
 * 每一步指着的真实入口。有示例项目时,也可以点开它继续;「下一步」始终可用。
 * 「创建智能体」「对话」两步在任务页的侧栏里(#2548 一张表),其余几步在侧栏底部我的头像菜单里(界面减法 #51)。
 */
type Target = { element: HTMLElement; action: boolean }
const visible = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false
  const box = el.getBoundingClientRect()
  return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
    && isElementVisible(el, { opacity: true })
}
/** The task page's one-list sidebar (left-sidebar). */
const SIDEBAR = '[data-region="left-sidebar"]'
function findTarget(step: TourStepId): Target | null {
  if ((step === 'tasks' || step === 'chats') && readPanelToggle('list:sessions')?.open === false) return null
  if (step === 'tasks') {
    const sample = document.querySelector('[data-tour="sample-project"]')
    if (visible(sample)) return { element: sample, action: true }
    const create = document.querySelector(`${SIDEBAR} [data-testid="sidebar-create-agent"]`)
    return visible(create) ? { element: create, action: false } : null
  }
  if (step === 'chats') {
    // The one list itself: its scroller holds every row (the conversations the shell draws into the list's slot, then the
    // project rows after them) and is the column on screen. ❌ The slot alone: it leaves out those project rows, is a
    // sliver on a new account and runs past the window on a long list. ❌ The 「对话」 header: it is going away.
    const list = document.querySelector(`${SIDEBAR} [data-region="sidebar-scroll"]`)
    return visible(list) ? { element: list, action: false } : null
  }
  // 界面减法 #51: 联系人, 市场, the assistant and 设置 are in my menu, behind my avatar at the sidebar's foot.
  const me = document.querySelector(`${SIDEBAR} [data-testid="me-menu-trigger"]`)
  return visible(me) ? { element: me, action: false } : null
}

/** 这一刻界面上找得到的步骤;找不到的那一步不出现,N 跟着少(规范 2.3)。「创建智能体」「对话」在「消息」里,能打开就算有。 */
export function availableTourSteps(): TourStepId[] {
  // 收起的侧栏只剩一列头像,创建智能体和这一列的字都不在。先用原有控制器展开,不能指着收起时的样子。
  const list = readPanelToggle('list:sessions')
  if (list && !list.open) list.toggle()
  const sidebarShown = visible(document.querySelector(SIDEBAR))
  return TOUR_STEPS.filter((step) => (step === 'tasks' || step === 'chats') ? sidebarShown || !!findTarget(step) : !!findTarget(step))
}

/** Bring the sidebar the step points into on screen: a collapsed sidebar is unfolded by its own controller. */
function openMessagesIfNeeded(step: TourStepId) {
  if ((step !== 'tasks' && step !== 'chats') || findTarget(step)) return
  const list = readPanelToggle('list:sessions')
  if (list && !list.open) list.toggle()
}

/**
 * The sidebar is unfolding: open, but its open/close progress has not reached 1. Its entries come in over the second half
 * (创建智能体 starts 0 wide and transparent, its opacity written each frame by the sidebar: below 1 until the progress is),
 * so one missing now is not absent yet: a tour started from the collapsed sidebar waits for it.
 */
function sidebarUnfolding(): boolean {
  const sidebar = document.querySelector(SIDEBAR)
  if (!sidebar || readPanelToggle('list:sessions')?.open !== true) return false
  const opacity = sidebar.querySelector<HTMLElement>('[data-testid="sidebar-create-agent"]')?.style.opacity
  return opacity !== undefined && opacity !== '' && Number.parseFloat(opacity) < 1
}

type Measurement = { step: TourStepId; target: Target | null; rect: DOMRect | null }
export function useTourTarget(step: TourStepId): { target: Target | null; rect: DOMRect | null; measured: boolean } {
  const [measurement, setMeasurement] = useState<Measurement | null>(null)
  useLayoutEffect(() => {
    openMessagesIfNeeded(step)
    let frame = 0
    let observed: HTMLElement | null = null
    const resize = new ResizeObserver(() => schedule())
    // 高亮、卡片、箭头在同一帧里按目标的新位置重算,❌ 三者错位(规范 2.3)。
    const measure = () => {
      frame = 0
      const next = findTarget(step)
      if (!next && (step === 'tasks' || step === 'chats') && sidebarUnfolding()) { schedule(); return }
      if (next?.element !== observed) {
        if (observed) resize.unobserve(observed)
        observed = next?.element ?? null
        if (observed) {
          resize.observe(observed)
          observed.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      }
      const box = next?.element.getBoundingClientRect() ?? null
      setMeasurement((current) => {
        const sameTarget = current?.target?.element === next?.element && current?.target?.action === next?.action
        const previous = current?.rect
        const sameBox = previous === box || (previous && box && previous.x === box.x && previous.y === box.y && previous.width === box.width && previous.height === box.height)
        return current?.step === step && sameTarget && sameBox ? current : { step, target: next, rect: box }
      })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    // Allow the messages controller one render frame before settling an absent target.
    if (findTarget(step)) measure()
    else schedule()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
    }
  }, [step])
  return measurement?.step === step
    ? { target: measurement.target, rect: measurement.rect, measured: true }
    : { target: null, rect: null, measured: false }
}
