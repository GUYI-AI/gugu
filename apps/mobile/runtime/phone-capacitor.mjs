import { AsyncLocalStorage } from 'node:async_hooks'

const calls = new AsyncLocalStorage()

/** Android and the WebView execute the same action definitions; only this byte transport changes. */
export const withPhoneNativeContext = (context, work) => calls.run(context, work)
export function registerPlugin(plugin) {
  return new Proxy({}, { get(_target, method) {
    if (method === 'then' || typeof method !== 'string') return undefined
    return async (args = {}) => {
      const context = calls.getStore()
      if (!context) throw new Error('Phone native call has no owning task')
      const { nativeCall, signal, recordPermissionRequirements, recordNativeFailure, ...metadata } = context
      let result
      try {
        result = await nativeCall('phone.native', { plugin, method, args }, signal, metadata)
        if (!result?.ok) throw Object.assign(new Error(result?.message ?? 'Phone tool failed'), { code: result?.code ?? 'failed' })
      } catch (error) { recordNativeFailure?.(error); throw error }
      if (result.permissionRequirements) await recordPermissionRequirements?.(result.permissionRequirements)
      return result.data
    }
  } })
}
