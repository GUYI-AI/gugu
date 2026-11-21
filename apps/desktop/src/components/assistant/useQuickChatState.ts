import { QUICK_CHAT_CHANNELS, shortcutLabel, type QuickChatState } from '../../lib/quickChatIpc'
import { rendererLogger } from '../../lib/log'
import { replica, useReplica, type Reading } from '../../lib/replica'
import { readRendererPlatform } from '../../lib/window-chrome'
import { desktopIpc } from '../../platform/desktopIpc'

const log = rendererLogger('assistant/quick-chat')

/** 快捷键此刻的样子(category ②:主进程的设备设置,渲染层只读)。跨重启留一份:齿轮页「快速聊天」冷开就在(❌ 晚插)。 */
export const quickChatState = replica({
  name: 'quickChatState',
  scope: 'device',
  read: async (): Promise<QuickChatState> => {
    const ipc = desktopIpc()
    if (!ipc) throw new Error('quick chat lives in the desktop app')
    return (await ipc.invoke(QUICK_CHAT_CHANNELS.state)) as QuickChatState
  },
  fresh: Infinity,
  persist: { maxBytes: 256, maxEntries: 1 },
  watch: { start: () => desktopIpc()!.eventOn(QUICK_CHAT_CHANNELS.changed, () => { void quickChatState.refresh() }) },
})

/** 不是桌面 = `available: false`(没有这扇小窗,❌ 一个读数);桌面上是读数:没读到、读到了、读不到。 */
export function useQuickChatState(): { available: boolean; reading: Reading<QuickChatState>; setEnabled: (on: boolean) => void } {
  const available = desktopIpc() !== null
  const reading = useReplica(quickChatState, available ? [] : null)
  const setEnabled = (on: boolean) => {
    const entry = quickChatState.at()
    void desktopIpc()?.invoke(QUICK_CHAT_CHANNELS.setEnabled, on)
      .then((next) => entry.set(next as QuickChatState), (error: unknown) => log.warn({ error: String(error) }, '快速聊天的开关没改成'))
  }
  return { available, reading, setEnabled }
}

export function quickChatShortcutLabel(state: QuickChatState): string {
  return shortcutLabel(state.accelerator, readRendererPlatform() === 'mac' ? 'darwin' : 'other')
}
