// #1925 (API 44, 46) The shell's word to main on the host page over each App's panel (AppHostLayerHost.tsx): which kind, for
// whom, and a task's ids — never sent to an App; main answers `hostPage`, `panel.hostPage` and `open` from it
// (app-host-layers.ts).
import type { AppHostLayer, AppHostLayers } from '../../lib/appHostLayerBridge'
import { rendererLogger } from '../../lib/log'
import { rpc } from '@/session/renderer/lib/ipc'
import type { AppHostLayerReport } from '@/session/shared/extensions/app-host-layer'

const log = rendererLogger('app-host-layer')

function reportOf(layer: AppHostLayer | undefined): AppHostLayerReport['layer'] {
  if (!layer) return null
  if (layer.kind === 'work') return { kind: 'work', ownerId: layer.ownerId, workId: layer.request.workId, sessionId: layer.request.task.sessionId }
  return { kind: layer.kind, ownerId: layer.ownerId }
}

/** What main was last told for each App; each change once. */
const reported = new Map<string, string>()
export function reportHostLayers(layers: AppHostLayers): void {
  for (const extensionId of new Set([...reported.keys(), ...Object.keys(layers)])) {
    const layer = reportOf(layers[extensionId])
    const key = JSON.stringify(layer)
    if ((reported.get(extensionId) ?? 'null') === key) continue
    if (layer) reported.set(extensionId, key)
    else reported.delete(extensionId)
    const warn = (error: unknown) => log.warn({ error }, 'The host page over an App\'s panel could not be reported')
    void Promise.resolve().then(() => rpc.extensions.reportHostLayer({ extensionId, layer })).then((result) => {
      if (!result.success) warn(result.error)
    }, warn)
  }
}

/** Tests only: a window that has reported nothing yet. */
export function forgetReportedHostLayersForTest(): void {
  reported.clear()
}
