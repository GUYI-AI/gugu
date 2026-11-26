import { closeNotice } from '@renderer/lib/hooks/use-toast';
import type { PermanentDeleteRun } from '../sessions/permanent-delete-flow';

/**
 * 撤销提示和删除的撤销窗口走同一个钟(第 2 稿:鼠标停在提示上暂停):
 *  · 鼠标停在 / 按在提示条上 —— 也正是提示条自己停表的条件 —— 窗口跟着停(`onHoverChange`,宿主报给的,❌ 自己去摸提示条)。
 *    窗口失焦时窗口也停(提示里的倒计时线自己听 window 的 blur / focus)。
 *  · 提示自己的停留远长于窗口;万一它先到点(窗口一直失焦而停着、提示却照走),就当窗口到点,现在删(`onAutoClose`)——
 *    两头总是一起结束。
 *  · 窗口一过先把提示收干净,它离开屏幕后才发第一批(`beforeDelete`):删除开始时屏幕上没有一个按了不管用的「撤销」。
 */
export function undoNoticeClock(key: string, run: () => PermanentDeleteRun) {
  return {
    notice: {
      onHoverChange: (hovering: boolean) => (hovering ? run().pauseUndo('hover') : run().resumeUndo('hover')),
      onAutoClose: () => run().commitNow(),
    },
    beforeDelete: () => closeNotice(key),
  };
}
