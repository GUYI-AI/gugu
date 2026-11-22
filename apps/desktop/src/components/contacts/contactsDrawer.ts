import { createContext, useContext, useEffect, useId, useRef, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'

// ContactsPageFrame 右边那一列抽屉的插槽:正文里的一行(新的请求)把自己的详情送进去;同一时刻只有最后打开的那一份。
// 抽屉被下一行拿走时,上一份关掉(onDisplaced)—— ❌ 只是不显示:那一行还以为自己开着,高亮就一直留着。

export type DrawerSlot = { el: HTMLElement | null; owner: string | null; claim: Dispatch<SetStateAction<string | null>> }
export const DrawerContext = createContext<DrawerSlot | null>(null)

/** 在 ContactsPageFrame 里:把 children 送进右边的抽屉;别的行接手抽屉时调 onDisplaced。不在里面(手机整页)= null,调用方照旧用自己的 Sheet。 */
export function useDrawerPortal(onDisplaced: () => void): ((children: ReactNode) => ReactNode) | null {
  const slot = useContext(DrawerContext)
  const id = useId()
  const claim = slot?.claim
  const owner = slot?.owner
  const held = useRef(false)
  useEffect(() => {
    if (!claim) return
    claim(id)
    return () => claim((current) => (current === id ? null : current))
  }, [claim, id])
  useEffect(() => {
    if (owner === id) held.current = true
    else if (held.current) {
      held.current = false
      onDisplaced()
    }
  }, [owner, id, onDisplaced])
  if (!slot) return null
  return (children) => (slot.el && slot.owner === id ? createPortal(children, slot.el) : null)
}
