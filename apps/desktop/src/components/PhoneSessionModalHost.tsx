import { lazy, Suspense, useState } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/replica'
import { useTheme } from '@/store/theme'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { sessionSkinClassName } from './sessionpage/sessionSkin'
import { SessionUiTheme } from './sessionpage/SessionUiTheme'

// The renderer and its dialogs are part of the task page's renderer chunk: pulled when a dialog is first asked for.
const ModalRenderer = lazy(() => import('@renderer/lib/modal/modal-renderer').then((m) => ({ default: m.ModalRenderer })))

/**
 * The phone shell has no task page, whose App draws the global session dialogs (modalStore: the archive confirmation,
 * the rename dialog). This is that one ModalRenderer for the phone: a dialog asked for from the chat list, a session
 * menu or contacts shows, ❌ asks into nothing. It wears the task page's skin as the settings sections do
 * (SessionSettingsSection), and the settings page only moves where it lands (modalStore.setPortalContainer).
 */
export const PhoneSessionModalHost = observer(function PhoneSessionModalHost() {
  const { theme } = useTheme()
  const [asked, setAsked] = useState(false)
  if (!asked && modalStore.activeModalId) setAsked(true)
  if (!asked) return null
  // At the end of <body>: above the phone's page layers (a session page is one), as a dialog over the whole screen is.
  return createPortal(<SessionUiTheme theme={theme} skin>
    <div className={sessionSkinClassName(theme)}>
      <QueryClientProvider client={queryClient}>
        <SessionLocalizationProvider>
          <Suspense fallback={null}><ModalRenderer /></Suspense>
        </SessionLocalizationProvider>
      </QueryClientProvider>
    </div>
  </SessionUiTheme>, document.body)
})
