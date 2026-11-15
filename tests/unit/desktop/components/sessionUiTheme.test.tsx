// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { SessionUiTheme } from '../../../../apps/desktop/src/components/sessionpage/SessionUiTheme'
import { ThemeProvider as SessionPageThemeProvider } from '../../../../apps/desktop/src/session/renderer/lib/providers/theme-provider'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const THEME_CLASSES = ['emlight', 'emdark']
const rootThemeClasses = () => THEME_CLASSES.filter((cls) => document.documentElement.classList.contains(cls))
let root: Root | null = null
let host: HTMLElement | null = null
let popupContainer: HTMLElement | undefined

function PopupContainerProbe() {
  popupContainer = useUiPortalContainer()
  return <span data-probe="" />
}

function render(node: ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(node) })
}

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  host?.remove()
  root = null
  host = null
  popupContainer = undefined
  document.documentElement.classList.remove(...THEME_CLASSES)
  delete (window as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__
})

describe('session-page components drawn by the shell keep the session theme off <html>', () => {
  it('a shell surface with no themed ancestor carries the class itself; its popups get a themed layer at the body', () => {
    render(<SessionUiTheme theme="dark"><PopupContainerProbe /></SessionUiTheme>)

    expect(rootThemeClasses()).toEqual([])
    const wrapper = host!.querySelector('[data-probe]')!.parentElement!
    expect(wrapper.className).toBe('emdark')
    expect(wrapper.style.display).toBe('contents')
    expect(popupContainer?.getAttribute('data-session-ui-popups')).toBe('')
    expect(popupContainer?.className).toBe('emdark')
    expect(popupContainer?.parentElement).toBe(document.body)
  })

  it('inside a themed ancestor (a chat in the session page mount) the wrapper adds no class of its own', () => {
    const mount = document.createElement('div')
    mount.className = 'emlight gugu-skin'
    document.body.appendChild(mount)
    root = createRoot(mount)
    act(() => { root!.render(<SessionUiTheme theme="light"><PopupContainerProbe /></SessionUiTheme>) })

    const wrapper = mount.querySelector('[data-probe]')!.parentElement!
    expect(wrapper.className).toBe('')
    expect(popupContainer?.className).toBe('emlight')
    act(() => { root!.unmount() })
    root = null
    mount.remove()
  })

  it('the session-page skin keeps popups in a fixed zero-size layer right next to the content', () => {
    render(<SessionUiTheme theme="light" skin><PopupContainerProbe /></SessionUiTheme>)

    expect(rootThemeClasses()).toEqual([])
    const wrapper = host!.querySelector('[data-probe]')!.parentElement!
    expect([...wrapper.classList]).toEqual(['emlight'])
    expect(wrapper.style.display).toBe('contents')
    expect(popupContainer?.parentElement).toBe(wrapper)
    expect(popupContainer?.className).toBe('emlight gugu-skin gg-session-settings-layer')
  })

  it('the embedded session page leaves <html> to the shell; opened on its own it still themes the root', () => {
    (window as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__ = document.createElement('div')
    render(<SessionPageThemeProvider><span /></SessionPageThemeProvider>)
    expect(rootThemeClasses()).toEqual([])
    act(() => { root!.unmount() })
    root = null

    delete (window as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__
    render(<SessionPageThemeProvider><span /></SessionPageThemeProvider>)
    expect(rootThemeClasses()).toHaveLength(1)
  })
})
