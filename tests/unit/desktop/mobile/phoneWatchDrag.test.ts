import { describe, expect, it } from 'vitest'
import { cornerFromPhoneDock, movePhoneWatch, phoneWatchCorner, phoneWatchDock } from '@/components/session-watch/phone-watch-drag'

describe('phone viewing window gestures', () => {
  it('restores on the same side and vertical half after docking on either edge', () => {
    const area = { x: 0, y: 8, width: 390, height: 640 }
    for (const [x, y, corner] of [[0, 8, 'top-left'], [346, 8, 'top-right'], [0, 576, 'bottom-left'], [346, 576, 'bottom-right']] as const) {
      const dock = phoneWatchDock({ x, y, width: 44, height: 72 }, area)
      expect(cornerFromPhoneDock(dock)).toBe(corner)
      expect(dock.ratio).toBe(y === 8 ? 0 : 1)
    }
  })
  it('keeps a dragged picture inside the message area while preserving its dimensions', () => {
    const picture = { x: 170, y: 400, width: 160, height: 90 }
    const area = { x: 16, y: 8, width: 358, height: 540 }
    expect(movePhoneWatch(picture, area, -1000, -1000)).toEqual({ x: 16, y: 8, width: 160, height: 90 })
    const moved = movePhoneWatch(picture, area, 1000, 1000)
    expect(moved).toEqual({ x: 214, y: 458, width: 160, height: 90 })
    expect(phoneWatchCorner(moved, area)).toBe('bottom-right')
  })
})
