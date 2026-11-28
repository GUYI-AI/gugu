import { describe, expect, it, vi } from 'vitest'
import { createMenuCloseRouting } from '../../../../apps/desktop/electron/menu-close-routing'

const window = (id: number) => ({ webContents: { id } })

describe('⌘W from the application menu', () => {
  it('closes the main window itself while no renderer has claimed Close (sign-in page, crashed or reloading renderer, start-up)', () => {
    const routing = createMenuCloseRouting()
    const main = window(1)
    const send = vi.fn(); const close = vi.fn()
    expect(routing.route(main, main, send, close)).toBe('closed')
    expect(close).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it('hands ⌘W to the main window renderer only while that page holds the claim', () => {
    const routing = createMenuCloseRouting()
    const main = window(1)
    const send = vi.fn(); const close = vi.fn()
    routing.claim(1, true)
    expect(routing.route(main, main, send, close)).toBe('renderer')
    routing.release(1)
    expect(routing.route(main, main, send, close)).toBe('closed')
    routing.claim(1, true); routing.claim(1, false)
    expect(routing.route(main, main, send, close)).toBe('closed')
    expect(send).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('other windows close directly even when the main window claimed Close', () => {
    const routing = createMenuCloseRouting()
    routing.claim(1, true)
    const send = vi.fn(); const close = vi.fn()
    expect(routing.route(window(7), window(1), send, close)).toBe('closed')
    expect(routing.route(undefined, window(1), send, close)).toBe('closed')
    expect(send).not.toHaveBeenCalled()
  })
})
