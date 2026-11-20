/**
 * #6753 左右两颗面板开关归窗口 chrome:控制器(一格一份、撤销只撤自己)、内容区让位车道在 Windows 收回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listSlotOf,
  publishPanelToggle,
  readPanelToggle,
} from '../../../../apps/desktop/src/lib/panelToggles'
import {
  SHELL_RESTORE_LANE_PX,
  shellRestoreLane,
} from '../../../../apps/desktop/src/lib/window-chrome'

describe('panelToggles 控制器', () => {
  beforeEach(() => vi.stubGlobal('window', {}))
  afterEach(() => vi.unstubAllGlobals())

  it('每个页签只认自己的列表栏;通讯录没有同构的列表栏', () => {
    expect(listSlotOf('tasks')).toBe('list:sessions')
    expect(listSlotOf('contacts')).toBeNull()
  })

  it('撤销只撤自己那一份:先登记的卸载不会撤掉后登记的', () => {
    const first = { open: true, label: 'Collapse', toggle: vi.fn() }
    const second = { open: false, label: 'Expand', toggle: vi.fn() }
    const withdrawFirst = publishPanelToggle('list:sessions', first)
    const withdrawSecond = publishPanelToggle('list:sessions', second)
    withdrawFirst()
    expect(readPanelToggle('list:sessions')).toBe(second)
    withdrawSecond()
    expect(readPanelToggle('list:sessions')).toBeNull()
  })
})

describe('内容区的侧栏开关车道', () => {
  it('the collapse toggle reserves the same content header lane on every platform', () => {
    for (const platform of ['win', 'mac', 'linux', 'other', undefined]) {
      expect(shellRestoreLane(platform)).toBe(SHELL_RESTORE_LANE_PX)
    }
  })
})
