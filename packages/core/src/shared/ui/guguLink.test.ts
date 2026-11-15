import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGuguLink, readGuguUrl } from './guguLink'

afterEach(() => vi.unstubAllGlobals())

/** A WebView before Chromium 130: a custom scheme's URL has no host, and its authority stays in the path. */
class OldWebViewUrl extends URL {
  private get custom() { return !/^https?:$/.test(this.protocol) }
  override get hostname() { return this.custom ? '' : super.hostname }
  override get host() { return this.custom ? '' : super.host }
  override get port() { return this.custom ? '' : super.port }
  override get pathname() { return this.custom ? this.href.slice(this.protocol.length).split(/[?#]/)[0]! : super.pathname }
}

const CHAT = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '22222222-2222-4222-8222-222222222222'

describe.each([['a current browser', false], ['an old WebView', true]])('parseGuguLink on %s', (_name, old) => {
  const parse = (raw: string) => {
    if (old) vi.stubGlobal('URL', OldWebViewUrl)
    return parseGuguLink(raw)
  }

  it('reads every kind of link', () => {
    expect(parse('gugu://ext/kanban/board?view=team')).toEqual({ kind: 'app', extensionId: 'kanban', tab: 'board', path: '', query: { view: 'team' }, place: null })
    expect(parse(`gugu://ext/kanban/board/a%20b?gugu.chat=${CHAT}`)).toMatchObject({ kind: 'app', path: 'a b', place: { chat: CHAT } })
    expect(parse('gugu-beta://app/kanban?variant=mine&device=d1')).toEqual({ kind: 'app-detail', extensionId: 'kanban', variant: 'mine', deviceId: 'd1' })
    expect(parse(`gugu://chat/${CHAT}/message/${MESSAGE}`)).toEqual({ kind: 'chat', chatId: CHAT, messageId: MESSAGE })
    expect(parse(`gugu://file/${CHAT}`)).toMatchObject({ kind: 'file', itemId: CHAT })
    expect(parse('gugu://session/s%201')).toEqual({ kind: 'session', sessionId: 's 1' })
    expect(parse('gugu://project/p1')).toEqual({ kind: 'project', projectId: 'p1' })
  })

  it('keeps what a custom scheme URL always meant at the edges', () => {
    // Space around a URL is not part of it.
    expect(parse('  gugu://project/p1 ')).toEqual({ kind: 'project', projectId: 'p1' })
    // No authority is no link, not a host found in the path.
    expect(parse('gugu:///ext/kanban/board')).toBeNull()
    expect(parse('gugu:ext/kanban/board')).toBeNull()
    // A backslash stays what it was written as: never a path separator.
    expect(parse('gugu://ext/kanban/a\\b')).toMatchObject({ kind: 'app', extensionId: 'kanban', tab: 'a%5Cb' })
    expect(parse('gugu://project/a\\b')).toEqual({ kind: 'project', projectId: 'a\\b' })
    // A port is a port, 443 too: an App detail link with one is refused.
    expect(parse('gugu://app:443/kanban')).toBeNull()
    expect(parse('gugu://app:80/kanban')).toBeNull()
    // The host is compared as written.
    expect(parse('gugu://APP/kanban')).toBeNull()
    expect(parse('https://ext/kanban/board')).toBeNull()
    expect(parse('gugu://ext/kanban')).toBeNull()
  })

  it('reads the authority of a login callback', () => {
    if (old) vi.stubGlobal('URL', OldWebViewUrl)
    expect(readGuguUrl('gugu-beta://auth/callback?code=1')?.host).toBe('auth')
    expect(readGuguUrl('https://auth/callback')).toBeNull()
  })
})
