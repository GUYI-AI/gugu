import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from 'react'

type Point = { x: number; y: number }
const distance = (points: Map<number, Point>) => {
  const [first, second] = [...points.values()]
  return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0
}
const scaleOf = (node: HTMLElement) => Math.max(1, Math.min(3, Number(node.dataset.phoneWatchZoom) || 1))

/** The retained picture owns its viewing scale, so switching conversations keeps the same view. */
export function usePhoneWatchZoom(root: RefObject<HTMLDivElement | null>, sourceId: string | null, enlarged: boolean, computer: boolean, operating: boolean) {
  const points = useRef(new Map<number, Point>())
  const start = useRef<{ distance: number; scale: number } | null>(null)
  const selected = () => [...root.current?.querySelectorAll<HTMLElement>('[data-live-window-picture]') ?? []]
    .find(node => node.dataset.liveWindowPicture === sourceId)
  useLayoutEffect(() => {
    points.current.clear(); start.current = null
    for (const node of root.current?.querySelectorAll<HTMLElement>('[data-live-window-picture]') ?? []) {
      const scale = computer && node.dataset.liveWindowPicture === sourceId ? scaleOf(node) : 1
      node.style.transformOrigin = '50% 50%'
      node.style.transform = scale === 1 ? '' : `scale(${scale})`
    }
  }, [root, sourceId, enlarged, computer])

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!enlarged || !computer || !operating || event.pointerType !== 'touch') return
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const node = selected()
    if (points.current.size === 2 && node) start.current = { distance: distance(points.current), scale: scaleOf(node) }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!points.current.has(event.pointerId)) return
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const node = selected(), initial = start.current
    if (points.current.size !== 2 || !initial || !node) return
    event.preventDefault()
    const scale = Math.max(1, Math.min(3, initial.scale * distance(points.current) / Math.max(1, initial.distance)))
    node.dataset.phoneWatchZoom = String(scale)
    node.style.transform = scale === 1 ? '' : `scale(${scale})`
  }
  const up = (event: PointerEvent<HTMLDivElement>) => {
    points.current.delete(event.pointerId)
    if (points.current.size < 2) start.current = null
  }
  return { onPointerDownCapture: down, onPointerMoveCapture: move, onPointerUpCapture: up, onPointerCancelCapture: up }
}
