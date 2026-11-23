import { observer } from 'mobx-react-lite'
import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from 'react'
import { MODAL_ROW_CENTER, ModalClose } from '@/components/ui/ModalClose'
import { publishPanelToggle } from '@/lib/panelToggles'
import { TITLEBAR_LEFT_EDGE_GAP_PX } from '@/lib/window-chrome'
import { getEffectiveHotkey, useShortcutOverrides } from '@renderer/lib/hooks/useKeyboardShortcuts'
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider'
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format'
import { useSessionMessages } from '@renderer/localization/use-session-messages'

/**
 * The sidebar's toggle, published for the shortcut and 消息 (lib/panelToggles). It draws nothing: GUYI-AI/gugu#2548 the
 * collapse button and the bell are in the one list's head (sidebar-one-list-chrome), on the sidebar's own top band.
 */
export const ShellSidebarToggle = observer(function ShellSidebarToggle() {
  const { translate } = useSessionMessages()
  const keyboard = useShortcutOverrides()
  const { isLeftOpen, toggleLeft } = useWorkspaceLayoutContext()
  const hotkey = getEffectiveHotkey('app.toggleLeftSidebar', keyboard)
  const shortcut = hotkey ? formatHotkeyText(hotkey) : undefined
  const label = translate(isLeftOpen ? 'task.collapseSidebar' : 'task.expandSidebar')

  useEffect(
    () =>
      publishPanelToggle('list:sessions', { open: isLeftOpen, label, toggle: toggleLeft, shortcut }),
    [isLeftOpen, label, shortcut, toggleLeft]
  )

  return null
})

/**
 * Set by a page shown as a modal (@@@page-modal): its title band is the modal's header, not the window's — no window handle;
 * it sits in a pane header's height, the ✕ where Settings has it (@@@page-modal-close), the page's own buttons left of it
 * on the same row.
 */
export const PageModalClose = createContext<(() => void) | null>(null)

/** The 40px title band, centred on the modal header's row (the ✕'s centre line). */
const MODAL_BAND: CSSProperties = { position: 'absolute', left: 0, top: `calc(${MODAL_ROW_CENTER} - 20px)`, right: 'calc(var(--control-h-lg) + var(--spacing-lg) + 4px)' }

/** The shared frameless-window handle used by full workspace and composer-only surfaces. */
export function ShellTitlebarDragRegion() {
  return (
    <div
      className="absolute inset-x-0 top-0 h-10 [-webkit-app-region:drag] pointer-events-none"
      data-session-titlebar-drag-region=""
    />
  )
}

/**
 * 会话页**唯一**的顶栏外壳。
 *
 * 为什么要有它:在它之前,同一个 app 里并行跑着两套 chrome —— 主页/新建任务/会话/项目用零高度浮层,
 * 而设置、自动化、技能、MCP 各自返回一条真的 40px 横条(其中技能与 MCP 那两条**里面一个控件都没有**,
 * 纯粹占 40px 高、画一条边框)。于是每换一屏就换一套顶栏。owner 实机原话:
 * 「我觉得这算是一个工作区,他应该得到统一,而不是这么分裂,一步一景」。
 *
 * 现在所有视图都用这一层:零高度浮层,不占版面、不画边框,内容从窗口顶端起。
 *  · leftSlot —— 这一屏的身份(标题 / 面包屑 / 项目菜单)。
 *  · children —— 右上角那一排里**属于窗口 chrome 的那层**(如工作区面板开关)。
 *    ❌ 没有工作区面板的视图别塞它:那个开关会去开新建会话页的面板,是个空动作。
 *
 * 竖直基线只有一个来源:28px 按钮居中在 40px 带里 = top 6px。❌ 别在调用点另写 top-*。
 *
 * ⚠️ 侧栏开关**不在这里** —— 这一层住在主区里、会跟着侧栏左右移动,而那枚按钮的要求正是"不移动"。
 * #2548 起它在一张表侧栏自己的头一行(sidebar-one-list-chrome),收起成一列头像时原地不动。
 */
export const ShellTitlebar = observer(function ShellTitlebar({
  leftSlot,
  children,
  dragRegion = true,
}: {
  leftSlot?: ReactNode
  children?: ReactNode
  /**
   * false: this band is not the window's handle — the page puts its own where nothing live is under it. An App's page is
   * a webview drawn in the resident layer, which comes before this band in the order Electron folds drag / no-drag
   * rectangles: a band over it wins over the webview's no-drag, and real clicks there move the window (CDP clicks don't).
   */
  dragRegion?: boolean
}) {
  const closeModal = useContext(PageModalClose)
  if (closeModal) {
    return (
      <div className="relative z-40 h-0">
        <div style={MODAL_BAND}>
          {leftSlot ? (
            <div className="absolute top-0 flex h-10 items-center" style={{ left: 'var(--spacing-2xl)' }} data-shell-titlebar-left="">
              {leftSlot}
            </div>
          ) : null}
          {children}
        </div>
        <ModalClose floating onClose={closeModal} />
      </div>
    )
  }
  return (
    <div className="relative z-40 h-0">
      {/* Keep the shell layout zero-height, but make the full top chrome lane a usable window handle.

          这条带压在两层上,两层都要让开,少一层按钮就点不动:
           · OS 层 —— `[-webkit-app-region:drag]` 的区域**吞掉一切指针事件**(Electron
             *Custom Window Interactions* 原文:「Draggable areas ignore all pointer events」)。
             退订的唯一办法是 `app-region: no-drag`,见 index.css 的 @@@titlebar-no-drag。
           · Blink 层 —— 它还是一个 `pointer-events: auto` 的覆盖层,位于 `z-40` 上下文,
             盖在这条带里所有普通流内容之上。只有窗口固定簇靠 `fixed z-50` 逃掉,其余容器
             (消息栏动作、会话栏 header、分割线顶部 40px)的点击都落到这个 div 身上。
             所以它必须 `pointer-events-none`。

          `pointer-events-none` ❌ 不会让窗口拖不动:拖拽区由 `app-region` 定义,不经 Blink
          的命中测试。真机实测(真鼠标点击,不是 elementFromPoint):只有 no-drag 时三个按钮
          全部点不到,叠加本行后全部点到,还原后又全部点不到。 */}
      {dragRegion ? <ShellTitlebarDragRegion /> : null}
      {leftSlot ? (
        <div
          className="absolute top-0 flex h-10 items-center [-webkit-app-region:no-drag]"
          style={{ left: TITLEBAR_LEFT_EDGE_GAP_PX }}
          data-shell-titlebar-left=""
        >
          {leftSlot}
        </div>
      ) : null}
      {children}
    </div>
  )
})
