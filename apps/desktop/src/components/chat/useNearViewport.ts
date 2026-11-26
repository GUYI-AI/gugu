import { useEffect, useState, type RefObject } from 'react'

/** 滚到眼前(含上下 400px)才去取:一屏一批,往回翻历史时不把整段都下了。 */
export function useNearViewport(ref: RefObject<Element | null>, enabled = true, rootMargin = '400px 0px'): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!enabled || near || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, near, enabled, rootMargin])
  return near
}
