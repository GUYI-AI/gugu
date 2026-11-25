import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { observer } from 'mobx-react-lite'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/replica'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { sessionSkinClassName } from './sessionpage/sessionSkin'
import { requestLayer } from '@renderer/app/aux-layers'
import { SessionUiTheme } from './sessionpage/SessionUiTheme'
import { SessionModalLayer } from './SessionModalLayer'

// The renderer and its dialogs are part of the task page's renderer chunk: pulled when a dialog is first asked for.
const ModalRenderer = lazy(() => import('@renderer/lib/modal/modal-renderer').then((m) => ({ default: m.ModalRenderer })))

/**
 * The one host of the global session dialogs (modalStore: archive confirmation, rename). The task page's App renders it,
 * inside its tree and providers; it portals to `<body>`, so a dialog asked for while the task page is kept hidden (contacts,
 * #3366) shows there, ❌ in the hidden page. The phone shell, with no task page, renders it. It wears the task page's skin
 * as the settings sections do (SessionSettingsSection); Settings and a page modal (workspace.tsx PageModal) only move where it lands (setPortalContainer).
 */
export const SessionModalHost = observer(function SessionModalHost() {
  const theme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme)
  const [asked, setAsked] = useState(false)
  // Each dialog opens in the window it was asked from (aux-layers: a pop-out's layer), fixed when it opens.
  const [opened, setOpened] = useState<{ id: string | null; layer: HTMLElement | null }>({ id: null, layer: null })
  const activeId = modalStore.activeModalId
  if (activeId !== opened.id) setOpened({ id: activeId, layer: activeId ? requestLayer() : opened.layer })
  if (!asked && activeId) setAsked(true)
  if (!asked) return null
  // At the end of <body>, on the modal layer: above every page layer (the task page is one, a fixed frame at z-index 5), as a
  // dialog over the whole screen is. The skin layer inside is the settings dialog's (z-index 1 within whatever holds it), so
  // this zero-size fixed box is what lifts it; without it a dialog asked for from the list (新建空白项目) opened under the page.
  return <SessionModalLayer container={opened.layer ?? undefined}><SessionUiTheme theme={theme} skin>
    <div className={sessionSkinClassName(theme)}>
      <QueryClientProvider client={queryClient}>
        <SessionLocalizationProvider>
          <Suspense fallback={null}><ModalRenderer /></Suspense>
        </SessionLocalizationProvider>
      </QueryClientProvider>
    </div>
  </SessionUiTheme></SessionModalLayer>
})
