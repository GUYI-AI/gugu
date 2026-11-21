import { useMemo, useState, type ReactNode } from 'react'
import { DrawerContext } from './contactsDrawer'
import { Pane, PaneHeader } from '../ui/Pane'
import { X } from '@/lib/icons'
import { IconButton } from '../contactsDetailControls'
import { ct } from './contactsPanelStyles'

// 通讯录桌面右侧的同一副版式:页头(标题 + 计数) · 可滚的正文 · 右边一列抽屉(占真实宽度,正文按剩下的宽度重排)。
// 分组页、搜索结果、新的请求都住在它里面 —— 同一处页头、同一列抽屉,切换时版式不跳。
// 抽屉的内容两种来法:父组件直接给(`drawer`,分组页 / 搜索的联系人资料),或者正文里的某一行把自己的详情送进来
// (`useDrawerPortal`,见 contactsDrawer;新的请求那几种行各自持有自己的详情与动作)。同一时刻只开着最后打开的那一份。

// data-pane-close + --pane-close-room: headers inside the drawer leave the close (below) its room (tokens.css, next to atWindowEdge).
const drawerClass = 'relative flex w-[400px] min-w-[360px] shrink-0 flex-col border-l border-[var(--border)] empty:hidden [--pane-close-room:var(--control-h-md)]'

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
  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      <Pane paneRole="detail" data-testid={testId}>
        {/* With the drawer shown it is the window's right column; otherwise this header is. */}
        <PaneHeader divider atWindowEdge={!drawer && owner === null} title={title} subtitle={subtitle} actions={actions} />
        <div className="flex-1 overflow-y-auto !px-6 !pb-6">
          <DrawerContext.Provider value={slot}>{children}</DrawerContext.Provider>
        </div>
      </Pane>
      <div ref={setEl} data-testid="contacts-detail-drawer" data-pane-close="" className={drawerClass}>
        {drawer ? <>{drawer}{onCloseDrawer ? <DrawerClose onClose={onCloseDrawer} /> : null}</> : null}
      </div>
    </div>
  )
}
