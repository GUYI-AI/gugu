import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isNativeAccountSender } from './ipc'
import { isAccountClosureV2ErrorCode, type AccountClosureV2Handle, type AccountClosureV2Native } from '../../src/platform/accountClosureV2'
export const DESKTOP_CLOSURE_V2_CHANNEL = 'account-closure:v2'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function registerDesktopClosureV2Ipc(ipc: Pick<IpcMain, 'handle'>, window: () => BrowserWindow | null, service: () => Promise<AccountClosureV2Native>) {
  ipc.handle(DESKTOP_CLOSURE_V2_CHANNEL, async (event: IpcMainInvokeEvent, input: unknown) => {
    try {
      if (!isNativeAccountSender(event, window())) return { ok: false, code: 'wrong_local_owner' }
      if (!object(input) || typeof input.type !== 'string' || Object.keys(input).some(k => !['type', 'handle', 'confirmation'].includes(k))) return { ok: false, code: 'invalid_scope' }
      const simple = ['readPolicy', 'discover', 'capture'].includes(input.type)
      const commands = ['sendCode', 'prepare', 'confirm', 'recover', 'cancel', 'finalize']
      if (!simple && !commands.includes(input.type)) return { ok: false, code: 'invalid_scope' }
      if (simple && (input.handle !== undefined || input.confirmation !== undefined)) return { ok: false, code: 'invalid_scope' }
      if (!simple && (!object(input.handle) || Object.keys(input.handle).some(k => !['localOperationId', 'nativeGeneration', 'localRevision'].includes(k)))) return { ok: false, code: 'invalid_scope' }
      if (input.type === 'confirm') {
        if (!object(input.confirmation) || Object.keys(input.confirmation).some(k => !['code', 'acknowledgeForfeit'].includes(k))
          || typeof input.confirmation.code !== 'string' || !/^[0-9]{6,10}$/.test(input.confirmation.code) || input.confirmation.acknowledgeForfeit !== true) return { ok: false, code: 'invalid_request' }
      } else if (input.confirmation !== undefined) return { ok: false, code: 'invalid_scope' }
      const host = await service(), h = input.handle as unknown as AccountClosureV2Handle
      let value: unknown
      switch (input.type) {
        case 'readPolicy': value = await host.readPolicy(); break
        case 'discover': value = await host.discover(); break
        case 'capture': value = await host.capture(); break
        case 'sendCode': value = await host.sendCode(h); break
        case 'prepare': value = await host.prepare(h); break
        case 'confirm': value = await host.confirm(h, { code: (input.confirmation as { code: string }).code, acknowledgeForfeit: true }); break
        case 'recover': value = await host.recover(h); break
        case 'cancel': value = await host.cancel(h); break
        case 'finalize': value = await host.finalize(h); break
        default: return { ok: false, code: 'invalid_scope' }
      }
      return { ok: true, value }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      return { ok: false, code: isAccountClosureV2ErrorCode(code) ? code : 'closure_unavailable' }
    }
  })
}


/** Separate explicit enable intent. The renderer supplies the owner it captured
 * when clicked; native identity/custody still decide whether anything resumes. */
export function registerDesktopClosureAgentResumeIpc(
  ipc: Pick<IpcMain, 'handle'>,
  window: () => BrowserWindow | null,
  service: () => Promise<{ resumePausedAgents(expectedOwnerId: string): Promise<void> }>,
) {
  ipc.handle('account-closure:resume-paused', async (event: IpcMainInvokeEvent, input: unknown) => {
    try {
      if (!isNativeAccountSender(event, window())) return { ok: false, code: 'wrong_local_owner' }
      if (!object(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'ownerId') || typeof input.ownerId !== 'string'
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.ownerId)) return { ok: false, code: 'invalid_scope' }
      await (await service()).resumePausedAgents(input.ownerId)
      return { ok: true }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      return { ok: false, code: isAccountClosureV2ErrorCode(code) ? code : 'closure_unavailable' }
    }
  })
}
