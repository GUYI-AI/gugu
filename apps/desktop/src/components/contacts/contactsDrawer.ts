import { createContext, useContext, useEffect, useId, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'

// ContactsPageFrame 右边那一列抽屉的插槽:正文里的一行(新的请求)把自己的详情送进去;同一时刻只显示最后打开的那一份。

export type DrawerSlot = { el: HTMLElement | null; owner: string | null; claim: Dispatch<SetStateAction<string | null>> }
export const DrawerContext = createContext<DrawerSlot | null>(null)

/** 在 ContactsPageFrame 里:把 children 送进右边的抽屉(最后打开的那一份显示)。不在里面(手机整页)= null,调用方照旧用自己的 Sheet。 */
export function useDrawerPortal(): ((children: ReactNode) => ReactNode) | null {
  const slot = useContext(DrawerContext)
  const id = useId()
  const claim = slot?.claim
  useEffect(() => {
    if (!claim) return
    claim(id)
    return () => claim((current) => (current === id ? null : current))
  }, [claim, id])
  if (!slot) return null
  return (children) => (slot.el && slot.owner === id ? createPortal(children, slot.el) : null)
}
