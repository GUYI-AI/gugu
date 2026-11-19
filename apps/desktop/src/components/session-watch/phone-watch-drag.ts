import type { LiveWindowCorner } from '@/session/renderer/features/live-window/types'

export type PhoneWatchCorner = LiveWindowCorner
export type PhoneWatchDock = { edge: 'left' | 'right'; ratio: number }
export type PhoneWatchBox = { x: number; y: number; width: number; height: number }

/** Snap only after the gesture: the person can move the picture freely while dragging. */
export function phoneWatchCorner(box: PhoneWatchBox, area: PhoneWatchBox): PhoneWatchCorner {
  return `${box.y + box.height / 2 < area.y + area.height / 2 ? 'top' : 'bottom'}-${box.x + box.width / 2 < area.x + area.width / 2 ? 'left' : 'right'}`
}

export function phoneWatchDock(box: PhoneWatchBox, area: PhoneWatchBox): PhoneWatchDock {
  return { edge: box.x + box.width / 2 < area.x + area.width / 2 ? 'left' : 'right',
    ratio: Math.max(0, Math.min(1, (box.y - area.y) / Math.max(1, area.height - box.height))) }
}

export function cornerFromPhoneDock(dock: PhoneWatchDock): PhoneWatchCorner {
  return `${dock.ratio < 0.5 ? 'top' : 'bottom'}-${dock.edge}`
}

export function movePhoneWatch(box: PhoneWatchBox, area: PhoneWatchBox, dx: number, dy: number): PhoneWatchBox {
  return { ...box,
    x: Math.max(area.x, Math.min(area.x + area.width - box.width, box.x + dx)),
    y: Math.max(area.y, Math.min(area.y + area.height - box.height, box.y + dy)) }
}
