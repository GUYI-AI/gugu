import { useEffect, useState, type RefObject } from 'react'

/**
 * 滚到眼前(含上下 400px)才去取:一屏一批,往回翻历史时不把整段都下了。进过一次就一直算在;`release` 时离开这段又变回 false
 * (一页 HTML 离屏就卸掉它的 frame)。
 */
export function useNearViewport(ref: RefObject<Element | null>, enabled = true, release = false): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!enabled || (near && !release) || !el) return
    const observer = new IntersectionObserver((entries) => {
      setNear(entries[entries.length - 1]!.isIntersecting)
    }, { rootMargin: '400px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, near, enabled, release])
  return near
}
