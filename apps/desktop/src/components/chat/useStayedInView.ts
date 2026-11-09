import { useEffect, useState } from 'react'

/**
 * True once `shown` has held with nothing scrolling for a moment. Mounting a guest page makes the compositor wait for its
 * first frame, which stalls a scroll in progress: a widget starts its page when the reader has stopped, not on the way past.
 */
export function useStayedInView(shown: boolean, ms = 180) {
  const [stayed, setStayed] = useState(false)
  useEffect(() => {
    if (!shown) { setStayed(false); return }
    let timer: ReturnType<typeof setTimeout>
    const wait = () => { clearTimeout(timer); timer = setTimeout(() => setStayed(true), ms) }
    wait()
    addEventListener('scroll', wait, { capture: true, passive: true })
    return () => { clearTimeout(timer); removeEventListener('scroll', wait, { capture: true }) }
  }, [shown, ms])
  return shown && stayed
}
