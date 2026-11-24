import { beforeEach } from 'vitest'
import { commands } from 'vitest/browser'

declare module 'vitest/browser' {
  interface BrowserCommands {
    /** Move the page's mouse off the page (vitest.config.ts `@@@pointer-park`). */
    parkPointer: () => Promise<void>
  }
}

// Every test starts with no pointer over the page: a test reads hover-revealed controls at rest only if nothing
// hovers them, and the pointer otherwise stays wherever the previous test (or file) left it.
beforeEach(async () => {
  await commands.parkPointer()
})
