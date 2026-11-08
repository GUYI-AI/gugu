import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ThemeProvider,
  UiPortalContainerProvider,
  usePortalThemeClass,
  useUiPortalContainer,
  type ThemeProviderProps,
} from '@gugu/session-ui/react/primitives'
import './SessionSettingsSection.css'

const CONTENTS = { display: 'contents' } as const
const THEMED = '.emlight, .emdark'

/**
 * The session page's theme for session-page components the shell draws itself, ❌ written on `<html>`.
 *
 * On `<html>`, `.emlight` / `.emdark` sits on the same element as the shell's `:root` / `[data-theme]` tokens, so
 * wherever both define a name (`--border`, `--background-*`, …) stylesheet order picked the winner and the session
 * page's values reached every shell element. The theme class moves to where these components are:
 *
 * - Content sits in a `display: contents` wrapper (layout unchanged). It carries the class only when nothing above
 *   it does. A chat drawn in the session page's mount inherits the mount's skin, which bridges the session palette
 *   to the shell's tokens; a class of its own there would re-declare the raw palette closer than the bridge.
 *   Elsewhere (the phone, shell pages, Settings) it carries the class `<html>` used to carry.
 * - Popups portal out of the wrapper and get a themed layer of their own. By default it is a `display: contents`
 *   layer where they already portaled to (the surface's declared layer, else `document.body`), so stacking is what
 *   it was. With `skin` (session-page parts inside a dialog or sheet) it is the session page's skin in a fixed,
 *   zero-size layer right here: the popup stays inside the dialog for focus, outside-press and inert, and is not
 *   clipped by its scroll area. A surface that paints the skin itself keeps its own `.gugu-skin` element.
 */
export function SessionUiTheme({ theme, skin = false, children }: {
  theme: ThemeProviderProps['theme']
  skin?: boolean
  children: ReactNode
}) {
  return (
    <ThemeProvider theme={theme} target="none">
      <ThemeScope skin={skin}>{children}</ThemeScope>
    </ThemeProvider>
  )
}

function ThemeScope({ skin, children }: { skin: boolean; children: ReactNode }) {
  const themeClass = usePortalThemeClass()
  const outer = useUiPortalContainer() ?? document.body
  const wrapper = useRef<HTMLDivElement>(null)
  const [inherited, setInherited] = useState(false)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => { setInherited(!!wrapper.current?.parentElement?.closest(THEMED)) }, [])
  return (
    <>
      <div ref={wrapper} className={inherited ? undefined : themeClass} style={CONTENTS}>
        <UiPortalContainerProvider value={layer ?? undefined}>{children}</UiPortalContainerProvider>
        {skin && <div ref={setLayer} className={`${themeClass} gugu-skin gg-session-settings-layer`} />}
      </div>
      {!skin && createPortal(<div ref={setLayer} className={themeClass} style={CONTENTS} data-session-ui-popups="" />, outer)}
    </>
  )
}
