import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '@/platform'
import { rendererLogger } from '@/lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { useToast } from '../toastContext'
import { useBackLayer } from '../ui/sheetStack'
import type { PhoneTextSelectionSource } from './phoneTextSelectionSource'

/** The phone shell owns native selection; browsers keep their own selection UI. */
export function PhoneTextSelection({ source, onDone }: {
  source: PhoneTextSelectionSource
  onDone: () => void
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [id] = useState(() => crypto.randomUUID())
  const callbacks = useRef({ onDone, toast, t })
  callbacks.current = { onDone, toast, t }
  useBackLayer(onDone)

  useLayoutEffect(() => {
    const native = platform.textSelection
    if (native) {
      let active = true
      let opened = false
      // A development StrictMode cleanup must not leave a native page opening after its owner unmounts.
      void Promise.resolve().then(() => {
        if (!active) return
        opened = true
        return native.open({ id, text: source.text, start: source.start, end: source.end,
        title: callbacks.current.t('message.actions.selectText'), closeLabel: callbacks.current.t('message.selectionClose'),
        dark: document.documentElement.dataset.theme === 'dark',
        })
      }).then(() => { if (active && opened) callbacks.current.onDone() }, error => {
        if (!active) return
        callbacks.current.toast(callbacks.current.t('message.selectTextFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error)))
        callbacks.current.onDone()
      })
      return () => {
        active = false
        if (opened) void native.close({ id }).catch(error => rendererLogger('phone-text-selection').error({ error }, 'Cannot close native text selection'))
      }
    }
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(source.browserRange)
    const changed = () => { if (!selection || selection.isCollapsed) callbacks.current.onDone() }
    document.addEventListener('selectionchange', changed)
    return () => {
      document.removeEventListener('selectionchange', changed)
      selection?.removeAllRanges()
    }
  }, [id, source])
  return null
}
