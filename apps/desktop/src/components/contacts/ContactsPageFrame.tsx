import { useCallback, useEffect, useMemo, useState, type PointerEvent, type ReactNode } from 'react'
import { useBackLayer } from '../ui/sheetStack'
import { DrawerContext } from './contactsDrawer'
import { Pane, PaneHeader } from '../ui/Pane'
import { X } from '@/lib/icons'
import { IconButton } from '../contactsDetailControls'
import { ct } from './contactsPanelStyles'

// 通讯录桌面右侧的同一副版式:页头(标题 + 计数) · 可滚的正文 · 右边一列抽屉(浮在正文右侧之上,正文宽度不变、不重排)。
// 分组页、搜索结果、新的请求都住在它里面 —— 同一处页头、同一列抽屉,切换时版式不跳。
// 抽屉的内容两种来法:父组件直接给(`drawer`,分组页 / 搜索的联系人资料),或者正文里的某一行把自己的详情送进来
// (`useDrawerPortal`,见 contactsDrawer;新的请求那几种行各自持有自己的详情与动作)。同一时刻只开着最后打开的那一份。

// data-pane-close + --pane-close-room: headers inside the drawer leave the close (below) its room (tokens.css, next to atWindowEdge).
const drawerClass = 'absolute inset-y-0 right-0 z-20 flex w-[400px] max-w-full flex-col border-l border-[var(--border)] bg-[var(--bg-primary)] shadow-[var(--shadow-overlay-panel)] empty:hidden [--pane-close-room:var(--control-h-md)]'
// 点在正文的空白处才关抽屉:点到行、卡片或任何控件是在用它们(点另一行 = 抽屉直接换成那一份)。
const IN_USE = '.gg-row, button, a, input, textarea, select, [role=button], [role=option], [contenteditable], [data-contact-id], [data-group-id]'

// The drawer is the window's right column: its close leaves the window controls their room (`--titlebar-controls-width`, Linux).
export function DrawerClose({ onClose }: { onClose: () => void }) {
  return <span className="absolute right-[calc(0.75rem+var(--titlebar-controls-width,0px))] top-3 z-10"><IconButton title={ct('common.close')} onClick={onClose}><X size={14} /></IconButton></span>
}

export function ContactsPageFrame({ title, subtitle, actions, drawer, onCloseDrawer, testId, children }: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  drawer?: ReactNode | null
  onCloseDrawer?: () => void
  testId?: string
  children: ReactNode
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [owner, claim] = useState<string | null>(null)
  const slot = useMemo(() => ({ el, owner, claim }), [el, owner])
  const open = Boolean(drawer) || owner !== null
  // 关 = 父组件给的那份收起 + 正文里的行交还抽屉(交还即 onDisplaced,那一行自己关掉,见 contactsDrawer)。
  const close = useCallback(() => { onCloseDrawer?.(); claim(null) }, [onCloseDrawer])
  // Escape / 安卓返回走同一个层栈:抽屉里再开的弹层在它上面,先关的是那一层。
  const isTopLayer = useBackLayer(close, open)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !isTopLayer()) return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, isTopLayer, close])
  const closeOnBlank = (event: PointerEvent<HTMLDivElement>) => {
    if (open && event.button === 0 && !(event.target as Element).closest(IN_USE)) close()
  }
  return (
    <div className="relative flex h-full min-w-0 flex-1 overflow-hidden">
      <Pane paneRole="detail" data-testid={testId}>
        <PaneHeader divider atWindowEdge title={title} subtitle={subtitle} actions={actions} />
        <div className="flex-1 overflow-y-auto !px-6 !pb-6" onPointerDown={closeOnBlank}>
          <DrawerContext.Provider value={slot}>{children}</DrawerContext.Provider>
        </div>
      </Pane>
      <div ref={setEl} data-testid="contacts-detail-drawer" data-pane-close="" className={drawerClass}>
        {drawer ? <>{drawer}{onCloseDrawer ? <DrawerClose onClose={onCloseDrawer} /> : null}</> : null}
      </div>
    </div>
  )
}
