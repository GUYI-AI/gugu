import { BETA_TYPING_DIAGNOSTICS_BUILD, TYPING_DIAGNOSTICS_SCOPE } from '../../shared/beta-typing-diagnostics'
import { RENDERER_LOG_CHANNEL } from './log'
import { createTypingDiagnosticsRecorder, type TypingDiagnosticReply } from './typing-diagnostics-recorder'

let current: ReturnType<typeof createTypingDiagnosticsRecorder> | null = null
let requested = false

export async function installBetaTypingDiagnostics(): Promise<void> {
  if (!BETA_TYPING_DIAGNOSTICS_BUILD || requested || typeof window === 'undefined' || window.top !== window || !window.desktopWindow || !window.electronAPI) return
  requested = true
  const api = window.electronAPI
  try {
    const config = await api.invoke(RENDERER_LOG_CHANNEL, { scope: TYPING_DIAGNOSTICS_SCOPE, fields: { operation: 'config' } }) as { enabled?: boolean } | undefined
    if (config?.enabled !== true) return
    current = createTypingDiagnosticsRecorder(window, async records => {
      const reply = await api.invoke(RENDERER_LOG_CHANNEL, { scope: TYPING_DIAGNOSTICS_SCOPE, fields: { operation: 'append', records } }) as TypingDiagnosticReply | undefined
      return reply?.accepted === true ? reply : { accepted: false, reason: reply?.reason }
    }, async () => {
      const reply = await api.invoke(RENDERER_LOG_CHANNEL, { scope: TYPING_DIAGNOSTICS_SCOPE, fields: { operation: 'claim-profile' } }) as { accepted?: boolean; capture?: number } | undefined
      return { accepted: reply?.accepted === true, capture: reply?.capture }
    })
    window.addEventListener('pagehide', () => { current?.stop(true); current = null }, { once: true })
  } catch { current?.stop(); current = null }
}

if (import.meta.hot) import.meta.hot.dispose(() => { current?.stop(true); current = null; requested = false })
