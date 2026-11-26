import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '@/platform'
import { rendererLogger } from '@/lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { useToast } from '../toastContext'
import { useBackLayer } from '../ui/sheetStack'
import type { PhoneTextSelectionSource } from './phoneTextSelectionSource'
import { phoneTextSelectionAppearance } from './phoneTextSelectionAppearance'
import { phoneTextSelectionRichText } from './phoneTextSelectionRichText'

/**
 * The phone shell owns native selection; browsers keep their own selection UI. With `onComment`, the native page offers
 * Comment beside Copy and hands the selected words back to it.
 */
export function PhoneTextSelection({ source, onDone, onComment }: {
  source: PhoneTextSelectionSource
  onDone: () => void
  onComment?: (words: string) => void
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [id] = useState(() => crypto.randomUUID())
  const callbacks = useRef({ onDone, onComment, toast, t })
  callbacks.current = { onDone, onComment, toast, t }
  useBackLayer(onDone)

  useLayoutEffect(() => {
    const native = platform.textSelection
    if (native) {
      let active = true
      let opened = false
      const element = source.element
      const previousVisibility = element.style.visibility
      // A development StrictMode cleanup must not leave a native page opening after its owner unmounts.
      void Promise.resolve().then(() => {
        if (!active) return
        opened = true
        const appearance = phoneTextSelectionAppearance(element)
        const rich = phoneTextSelectionRichText(source)
        element.style.visibility = 'hidden'
        return native.open({ id, ...rich,
          title: callbacks.current.t('message.actions.selectText'), closeLabel: callbacks.current.t('message.selectionClose'),
          ...(callbacks.current.onComment ? { commentLabel: callbacks.current.t('message.actions.comment') } : {}),
          dark: document.documentElement.dataset.theme === 'dark',
          appearance,
        })
      }).then(closed => {
        if (!active || !opened) return
        if (closed?.comment) callbacks.current.onComment?.(closed.comment)
        callbacks.current.onDone()
      }, error => {
        if (!active) return
        callbacks.current.toast(callbacks.current.t('message.selectTextFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error)))
        callbacks.current.onDone()
      })
      return () => {
        active = false
        element.style.visibility = previousVisibility
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
