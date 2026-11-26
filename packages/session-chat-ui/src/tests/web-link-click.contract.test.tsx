/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import type { JSX } from 'solid-js'
import { parseMarkdownToBlocks } from '../core/markdown/parse'
import type { HtmlBlock } from '../core/markdown/document'
import { htmlBlockDef } from '@session-chat/components/rows/markdown/html/html.def'
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext'
import { CachesContext } from '@session-chat/components/contexts/CachesContext'
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext'
import type { ChatCommands } from '../commands'
import { makeContractCtx } from './contract'

const web = 'https://example.org/prices'

async function clickLink(markdown: string, commands: ChatCommands, modifiers: MouseEventInit = {}) {
  const ctx = makeContractCtx({ width: 640 })
  const block = parseMarkdownToBlocks('web-link', markdown).find((block): block is HtmlBlock => block.kind === 'html')!
  const node = htmlBlockDef.measure(block, ctx)
  const host = document.createElement('div')
  document.body.append(host)
  const Component = htmlBlockDef.Render as (props: { node: typeof node }) => JSX.Element
  const dispose = render(() => <ThemeContext.Provider value={() => ctx.theme}>
    <CachesContext.Provider value={ctx.caches}><CommandsContext.Provider value={() => commands}>
      <Component node={node} />
    </CommandsContext.Provider></CachesContext.Provider>
  </ThemeContext.Provider>, host)
  try {
    const anchor = host.querySelector('a')!
    expect(anchor).not.toBeNull()
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }))
  } finally { dispose(); host.remove() }
}

describe('transcript web-link clicks', () => {
  it('hands an ordinary click to the host pane opener', async () => {
    const open = vi.fn(() => true)
    const external = vi.spyOn(window, 'open').mockReturnValue(null)
    try {
      await clickLink(`[prices](${web})`, { onOpenWebLink: open })
      expect(open).toHaveBeenCalledWith(web, expect.objectContaining({ metaKey: false, ctrlKey: false }))
      expect(external).not.toHaveBeenCalled()
    } finally { external.mockRestore() }
  })

  it.each([{ metaKey: true }, { ctrlKey: true }])('keeps the system-browser route when the host declines a modified click: %j', async modifiers => {
    const open = vi.fn(() => false)
    const external = vi.spyOn(window, 'open').mockReturnValue(null)
    try {
      await clickLink(`[prices](${web})`, { onOpenWebLink: open }, modifiers)
      expect(open).toHaveBeenCalledWith(web, expect.objectContaining(modifiers))
      expect(external).toHaveBeenCalledExactlyOnceWith(web, '_blank', 'noopener,noreferrer')
    } finally { external.mockRestore() }
  })

  it('keeps workspace file paths with their existing opener and fragment', async () => {
    const open = vi.fn(), file = vi.fn()
    await clickLink('[notes](./notes.md#section)', {
      classifyLink: () => ({ kind: 'workspace-file', path: './notes.md', at: { section: '' } }),
      onOpenFile: file,
      onOpenWebLink: open,
    })
    expect(file).toHaveBeenCalledWith(expect.objectContaining({ path: './notes.md', at: { section: '' } }))
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps product links ahead of the web opener', async () => {
    const open = vi.fn(), product = vi.fn(() => true)
    await clickLink(`[prices](${web})`, { onOpenLink: product, onOpenWebLink: open })
    expect(product).toHaveBeenCalledWith(web)
    expect(open).not.toHaveBeenCalled()
  })
})
