import { afterEach, describe, expect, it, vi } from 'vitest'
import { guguLink, parseGuguLink, parseShortRef, readGuguUrl } from './guguLink'

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

  it('round-trips an agent detail without treating it as an extension', () => {
    const target = { kind: 'agent-app-detail', agentId: 'kiro-cli', deviceId: 'device-1' } as const
    expect(parse(guguLink(target, 'gugu-beta'))).toEqual(target)
    expect(parse('gugu://agent-app/codex')).toEqual({ kind: 'agent-app-detail', agentId: 'codex' })
    expect(parse('gugu://agent-app/codex?variant=local')).toBeNull()
    expect(parse('gugu://agent-app/codex?device=a&device=b')).toBeNull()
    expect(parse('gugu://agent-app/codex?device=')).toBeNull()
    expect(parse('gugu://agent-app/codex/extra')).toBeNull()
  })

  it('reads the authority of a login callback', () => {
    if (old) vi.stubGlobal('URL', OldWebViewUrl)
    expect(readGuguUrl('gugu-beta://auth/callback?code=1')?.host).toBe('auth')
    expect(readGuguUrl('https://auth/callback')).toBeNull()
  })
})

// Owner 2026-11-27: a reference is a whole link the product wrote, or a short id — nothing in between.
describe('short ids and whole links', () => {
  const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', message = '11111111-2222-4333-8444-555555555555'

  it('reads msg: and session: with the whole id or its first 8+ characters', () => {
    expect(parseShortRef('session:4DF04861')).toEqual({ kind: 'session', id: '4df04861' })
    expect(parseShortRef('msg:1a2b3c4d-5e')).toEqual({ kind: 'msg', id: '1a2b3c4d-5e' })
    expect(parseShortRef(`session:${message}`)).toEqual({ kind: 'session', id: message })
    for (const text of ['session:4df0486', 'session:zzzzzzzz', 'msg:1a2b3c4d5e', 'aid:4df04861', `gugu-chat://${chat}/1a2b3c4d`]) expect(parseShortRef(text)).toBeNull()
  })

  it('reads a conversation link only with whole ids', () => {
    expect(parseGuguLink(`gugu-chat://${chat}/${message}`)).toEqual({ kind: 'chat', chatId: chat, messageId: message })
    expect(parseGuguLink(`gugu-chat://${chat}/1a2b3c4d`)).toBeNull()
  })
})
