import { useEffect } from 'react'
import { startAssistantAppStatus } from '../../lib/assistantAppHost'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import { readIdentityDirectoryBridge } from '../../lib/identityDirectoryBridge'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { rpc } from '../../session/renderer/lib/ipc'

const log = rendererLogger('assistant/app-status')

/**
 * #1925 An App bound to the person's own assistant reads a small snapshot of it (`gugu.assistant.status` / `onChanged`):
 * the shell's own snapshot (AssistantShellHost publishes it), passed on to main as an App may see it each time it moves —
 * main keeps it, and tells the pages of each App still entitled to hear it. Desktop only, as the binding is.
 */
export function useAssistantAppStatus(): void {
  useEffect(() => {
    if (!platform.capabilities.agentRuntime) return
    const shell = readAssistantShellBridge()
    if (!shell) return
    return startAssistantAppStatus({
      shell,
      // Imported when asked, as host-action-handlers does: the face drawing pulls in the look engine.
      face: async (id, avatar) => (await import('../../lib/memberFaces')).memberFace(id, avatar),
      push: async (pushed) => {
        const result = await rpc.extensions.assistantStatusChanged(pushed)
        if (!result.success) throw new Error(result.error)
      },
      // Its face is drawn once the identity directory has it.
      changes: (listener) => readIdentityDirectoryBridge()?.subscribe(listener) ?? (() => undefined),
      warn: (message, error) => log.warn({ error: error instanceof Error ? error.message : String(error) }, message),
    })
  }, [])
}
