import { useEffect, useState, type RefObject } from 'react'

/**
 * 滚到眼前(含上下 400px)才去取:一屏一批,往回翻历史时不把整段都下了。进过一次就一直算在;`release` 时离开这段又变回 false
 * (一页 html-render 离屏就卸掉它的 frame)。
 */
export function useNearViewport(ref: RefObject<Element | null>, enabled = true, rootMargin = '400px 0px', release = false): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!enabled || (near && !release) || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (release) setNear(entries[entries.length - 1]!.isIntersecting)
      else if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, near, enabled, rootMargin, release])
  return near
}
