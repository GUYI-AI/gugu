import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')
const appFrame = read('apps/desktop/src/session/renderer/features/apps/app-conversation-frame.tsx')

describe('workspace surfaces share one stacking contract', () => {

  it('draws a host control over an App page\'s corner on its own level, above the page and below the dividers (#1925)', () => {
    expect(appFrame).toContain("zIndex: 'var(--z-pane-resident-chrome)'")
    expect(appFrame).not.toMatch(/zIndex:\s*\d/)
  })
})
