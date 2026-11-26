import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Shortcuts are registered once (COMMANDS in session/shared/commands.ts) and answered by one dispatcher
 * (session/renderer/lib/commands/keyboard-dispatcher.tsx): settings, the cheat sheet, the palette and the menu read the
 * same table. A component that listens for keydown on a whole document/window, or binds a key with useHotkey, is a
 * second keymap nobody else can see — that is how ⌘1, ⌘W and ⌘↑↓ came to mean two things at once.
 *
 * The files below listen for keys that are not app shortcuts: a control's own keys while it is open (a viewer, a
 * menu, a tour), the transports that hand keys to the dispatcher, or input bookkeeping. A new file here needs the same
 * kind of reason; an app shortcut goes into COMMANDS instead.
 */
const ALLOWED: Record<string, string> = {
  'apps/desktop/src/session/renderer/lib/commands/keyboard-dispatcher.tsx': 'the dispatcher itself',
  'apps/desktop/src/session/renderer/lib/aux-document.ts': 'transport: hands a popped-out window\'s keys to the dispatcher',
  'apps/desktop/src/components/ContentContextMenuHost.tsx': 'an open context menu\'s own item accelerators',
  'apps/desktop/src/components/ImagePreviewProvider.tsx': 'the open image viewer\'s own keys',
  'apps/desktop/src/components/imageAnnotate/useAnnotateCanvas.ts': 'the open annotation canvas\'s own keys',
  'apps/desktop/src/components/chat/useMessageFilePreview.tsx': 'Escape out of an open file preview',
  'apps/desktop/src/components/contacts/ContactsPageFrame.tsx': 'Escape out of an open contacts page',
  'apps/desktop/src/components/firstRun/FirstRunHints.tsx': 'dismisses a first-run hint on any key',
  'apps/desktop/src/components/preview/FileSelectionMenu.tsx': 'Escape out of an open selection menu',
  'apps/desktop/src/components/preview/file-content-zoom.ts': 'the open file viewer\'s zoom keys',
  'apps/desktop/src/components/productTour/ProductTour.tsx': 'the open product tour\'s own keys',
  'apps/desktop/src/lib/flowList.ts': 'select-all inside a virtual list (prepares the rows)',
  'apps/desktop/src/lib/focus-modality.ts': 'input bookkeeping: keyboard vs pointer focus',
  'apps/desktop/src/lib/localRendererDiagnostics.ts': 'input bookkeeping: diagnostics',
  'apps/desktop/src/lib/typing-diagnostics-recorder.ts': 'input bookkeeping: diagnostics',
  'apps/desktop/src/mobile/usePhoneImeDismiss.ts': 'phone IME dismissal on Enter',
  'apps/desktop/src/session/app-runtime/modal.ts': 'an App modal\'s focus trap',
  'apps/desktop/src/session/renderer/app/aux-layers.ts': 'input bookkeeping: which window was last used',
  'apps/desktop/src/session/renderer/app/floating-card-keys.ts': 'typing while the floating card is up goes to its composer',
  'apps/desktop/src/session/renderer/features/browser/browser-annotations.tsx': 'Escape out of an active annotation',
  'apps/desktop/src/session/renderer/features/projects/components/main-panel/project-folder-card.tsx': 'Escape out of an open folder menu',
  'apps/desktop/src/session/renderer/features/tabs/chat-workspace-chrome.tsx': 'Escape out of a full-screen tab',
  'apps/desktop/src/session/renderer/features/tabs/tab-fullscreen.ts': 'Escape out of a full-screen tab',
  'apps/desktop/src/session/renderer/features/tabs/use-chat-workspace-divider.ts': 'Escape cancels an ongoing divider drag',
  'apps/desktop/src/session/renderer/lib/components/github-device-flow-modal.tsx': 'the open sign-in dialog\'s own keys',
  'apps/desktop/src/session/renderer/lib/hooks/use-arrow-key-navigation.ts': 'arrow keys inside one list',
  'apps/desktop/src/session/renderer/lib/pty/file-link-provider.ts': 'modifier state for terminal link hover',
  'apps/desktop/src/session/shared/preview/preview-link-script.ts': 'runs inside a preview page, not the app',
}

const ROOTS = ['apps/desktop/src', 'packages']
const PATTERN = /addEventListener\(\s*['"]keydown['"]|\buseHotkey\(/

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'tests' || name === '__tests__') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|stories)\.tsx?$/.test(name)) yield path
  }
}

describe('one shortcut table', () => {
  it('no new whole-document key listener or useHotkey outside the dispatcher', () => {
    const root = process.cwd()
    const found = ROOTS.flatMap((dir) => [...sources(join(root, dir))])
      .filter((path) => PATTERN.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path))
    const unexpected = found.filter((path) => !(path in ALLOWED))
    expect(unexpected, 'register the shortcut in COMMANDS (session/shared/commands.ts) and handle it with useCommandProvider').toEqual([])
    const stale = Object.keys(ALLOWED).filter((path) => !found.includes(path))
    expect(stale, 'these no longer listen for keys: drop them from ALLOWED').toEqual([])
  })

  it('no shortcut written as literal text in a label or hint: it goes stale when the binding moves or the user rebinds', () => {
    const root = process.cwd()
    const LITERAL = /keyHint="[⌘⌥⌃⇧]|\([⌘⌥⌃⇧][^)]{0,4}\)"/
    const hits = [...sources(join(root, 'apps/desktop/src'))]
      .filter((path) => LITERAL.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path))
    expect(hits, 'read the binding from the registry (getEffectiveHotkey + formatHotkeyText, or <BoundShortcut>)').toEqual([])
  })
})
