import { detectPlatform, matchesKeyboardEvent } from '@tanstack/react-hotkeys'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RENDERER_CONTENT_MENU_OPEN, RENDERER_MESSAGE_MENU_OPEN, finishRendererContentMenu, type RendererContentContextMenu, type RendererMessageMenu } from '@/lib/contentContextMenu'
import { desktopIpc } from '@/platform/desktopIpc'
import { CONTENT_CONTEXT_MENU_ACTION, CONTENT_CONTEXT_MENU_OPEN, type ContentContextMenu } from '@/session/shared/content-context-menu'
import { useToast } from './toastContext'
import { ContentMenu } from './ContentMenu'
import { MsgMoreMenu } from './chat/MsgMoreMenu'
import { MobileFileContextMenu } from './preview/MobileFileContextMenu'

/** Only presentation crosses into the renderer; the host retains the captured action closures. */
export function ContentContextMenuHost() {
  const [menu, setMenu] = useState<RendererContentContextMenu | null>(null)
  // A lifted (phone) menu stays mounted closed until the next one: its bubble settles back as it closes.
  const [messageMenu, setMessageMenu] = useState<(RendererMessageMenu & { open: boolean }) | null>(null)
  const { toast } = useToast()
  const finish = useCallback((requestId: string, actionId?: string) => {
    setMenu(current => current?.requestId === requestId ? null : current)
    if (finishRendererContentMenu(requestId, actionId)) return
    void desktopIpc()?.invoke(CONTENT_CONTEXT_MENU_ACTION, { requestId, actionId })
      .catch(error => toast(String(error), 'error'))
  }, [toast])

  useEffect(() => {
    const open = (event: Event) => setMenu((event as CustomEvent<RendererContentContextMenu>).detail)
    window.addEventListener(RENDERER_CONTENT_MENU_OPEN, open)
    return () => window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, open)
  }, [])

  useEffect(() => {
    const open = (event: Event) => setMessageMenu({ ...(event as CustomEvent<RendererMessageMenu>).detail, open: true })
    window.addEventListener(RENDERER_MESSAGE_MENU_OPEN, open)
    return () => window.removeEventListener(RENDERER_MESSAGE_MENU_OPEN, open)
  }, [])

  useEffect(() => desktopIpc()?.eventOn(CONTENT_CONTEXT_MENU_OPEN, data => {
    setMenu(data as ContentContextMenu)
  }), [])

  useEffect(() => {
    if (!menu) return
    const platform = detectPlatform()
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const item = menu.items.find(item => item.type !== 'separator' && item.hotkey && matchesKeyboardEvent(event, item.hotkey, platform))
      if (!item || item.type === 'separator') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (item.enabled !== false) finish(menu.requestId, item.id)
    }
    window.addEventListener('keydown', keydown, true)
    const blur = () => finish(menu.requestId)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('blur', blur)
      finish(menu.requestId)
    }
  }, [finish, menu])

  return <>
    {menu && <ContentMenu key={menu.requestId} menu={menu} onClose={() => finish(menu.requestId)} onAction={actionId => finish(menu.requestId, actionId)} />}
    {messageMenu && <MessageMenu key={messageMenu.requestId} menu={messageMenu} onClose={() => setMessageMenu(menu => menu?.lift ? { ...menu, open: false } : null)} />}
    <MobileFileContextMenu />
  </>
}

/** A timeline message's menu: the chat's own, without reactions (a task has nowhere to put one). */
function MessageMenu({ menu: { lift, open, ...menu }, onClose }: { menu: RendererMessageMenu & { open: boolean }; onClose: () => void }) {
  const bubble = useMemo(() => ({ current: lift?.bubble ?? null }), [lift?.bubble])
  if (lift) return <MsgMoreMenu {...menu} hasHoverBar onReact={() => undefined} onClose={onClose} lift={{ open, bubble, touchY: lift.touchY, mine: lift.mine }} />
  return open ? <MsgMoreMenu {...menu} hasHoverBar onReact={() => undefined} onClose={onClose} /> : null
}
