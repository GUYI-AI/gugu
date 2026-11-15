import { useLayoutEffect, useState } from 'react'
import { TOUR_STEPS, type TourStepId } from '../../lib/productTour'
import { readPanelToggle } from '../../lib/panelToggles'

/**
 * 每一步指着的真实入口。有示例项目时,也可以点开它继续;「下一步」始终可用。
 * 「创建智能体」「对话」两步在任务页的侧栏里(#2548 一张表):侧栏不在屏上时先把「消息」打开,❌ 别的入口替人点。
 */
type Target = { element: HTMLElement; action: boolean }
const visible = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false
  const box = el.getBoundingClientRect()
  return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
    && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
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
  const rail = document.querySelector(`.gg-sidebar-rail [data-rail="${step}"]`)
  return visible(rail) ? { element: rail, action: false } : null
}

/** 这一刻界面上找得到的步骤;找不到的那一步不出现,N 跟着少(规范 2.3)。「创建智能体」「对话」在「消息」里,能打开就算有。 */
export function availableTourSteps(): TourStepId[] {
  // 收起的侧栏只剩一列头像,创建智能体和这一列的字都不在。先用原有控制器展开,不能指着收起时的样子。
  const list = readPanelToggle('list:sessions')
  if (list && !list.open) list.toggle()
  const messages = document.querySelector('.gg-sidebar-rail [data-rail="chats"]')
  const messagesVisible = messages instanceof HTMLElement && messages.getBoundingClientRect().width > 0 && messages.getBoundingClientRect().height > 0
  return TOUR_STEPS.filter((step) => (step === 'tasks' || step === 'chats') ? messagesVisible || !!findTarget(step) : !!findTarget(step))
}

/**
 * Bring the sidebar the step points into on screen. Another tab of the shell is up: 消息 opens the task page. The task
 * page is up: 消息 would only fold its sidebar (#2548, there it is the sidebar's toggle), so a collapsed sidebar is
 * unfolded by its own controller, and an expanded one is left as it is (the step goes without its entry).
 */
function openMessagesIfNeeded(step: TourStepId) {
  if ((step !== 'tasks' && step !== 'chats') || findTarget(step)) return
  if (!visible(document.querySelector(SIDEBAR))) {
    document.querySelector<HTMLElement>('.gg-sidebar-rail [data-rail="chats"]')?.click()
    return
  }
  const list = readPanelToggle('list:sessions')
  if (list && !list.open) list.toggle()
}

/**
 * The sidebar is unfolding: open, but its open/close progress has not reached 1 (`--gg-sidebar-progress`, layout-provider's
 * SIDEBAR_PROGRESS_VAR on the sidebar's content layer). Its entries come in over the second half (创建智能体 starts 0 wide
 * and transparent), so one missing now is not absent yet: a tour started from the collapsed sidebar waits for it.
 */
function sidebarUnfolding(): boolean {
  const sidebar = document.querySelector(SIDEBAR)
  if (!sidebar || readPanelToggle('list:sessions')?.open !== true) return false
  return Number.parseFloat(getComputedStyle(sidebar).getPropertyValue('--gg-sidebar-progress')) < 1
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
