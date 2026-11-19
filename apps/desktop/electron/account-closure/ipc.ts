import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import type { AccountClosureErrorCode, AccountClosureScope } from '../../src/platform/accountClosure'
import type { createDesktopClosureService } from './service'

export const DESKTOP_CLOSURE_CHANNEL = 'account-closure:local'
const codes = new Set<AccountClosureErrorCode>(['closure_context_missing', 'closure_not_prepared', 'wrong_local_owner', 'scope_conflict', 'receipt_missing', 'invalid_scope', 'closure_storage_unavailable'])
type Service = ReturnType<typeof createDesktopClosureService>
export function isNativeAccountSender(event: IpcMainInvokeEvent, host: BrowserWindow | null): boolean {
  return !!host && !host.isDestroyed() && event.sender === host.webContents && event.senderFrame === event.sender.mainFrame
}
export function registerDesktopClosureIpc(ipc: Pick<IpcMain, 'handle'>, window: () => BrowserWindow | null, service: () => Service) {
  ipc.handle(DESKTOP_CLOSURE_CHANNEL, async (event: IpcMainInvokeEvent, input: unknown) => {
    try {
      const host = window()
      if (!isNativeAccountSender(event, host)) {
        return { ok: false, code: 'wrong_local_owner' }
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'invalid_scope' }
      const command = input as { type?: unknown; scope: AccountClosureScope; receipt?: unknown }
      const hostService = service()
      let value: unknown
      switch (command.type) {
        case 'put':
          if (typeof command.receipt !== 'string') return { ok: false, code: 'invalid_scope' }
          value = await hostService.native.receipt.put(command.scope, command.receipt); break
        case 'get': value = await hostService.native.receipt.get(command.scope); break
        case 'remove': value = await hostService.native.receipt.remove(command.scope); break
        case 'eraseLocal': value = await hostService.native.eraseLocal(command.scope); break
        case 'prepare': value = await hostService.prepare(command.scope); break
        case 'cancel': value = await hostService.cancel(command.scope); break
        default: return { ok: false, code: 'invalid_scope' }
      }
      return { ok: true, value }
    } catch (error) {
      const code = (error as { code?: AccountClosureErrorCode } | null)?.code
      return { ok: false, code: code && codes.has(code) ? code : 'closure_storage_unavailable' }
    }
  })
}
