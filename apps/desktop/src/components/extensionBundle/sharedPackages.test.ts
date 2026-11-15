import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One read of a chat's shared App packages at a time, shared by everyone who asks (摩擦单 F15's offer in the group's
 * panel; the via-App badge on a whisper, #6840) — read again only when a package is sent in that chat (摩擦单 F66: the
 * account revision bus says so, whatever is on screen).
 */

const files = new Map<string, { fileName: string; messageId: string; source: { kind: 'url'; url: string } }[]>()
const getChatFiles = vi.fn(async (chatId: string) => files.get(chatId) ?? [])
vi.mock('../../lib/chat', () => ({ chatService: { getChatFiles: (chatId: string) => getChatFiles(chatId) } }))
vi.mock('../../lib/log', () => ({ rendererLogger: () => ({ warn: () => undefined, info: () => undefined }) }))
// A package's bytes are its URL here; its manifest is read from that: `…/<id>-<version>.guguext`.
vi.mock('./summarizeExtensionBundle', () => ({
  summarizeExtensionBundle: async (bytes: Uint8Array) => {
    const [, id, version] = new TextDecoder().decode(bytes).match(/\/([a-z]+)-([\d.]+)\.guguext$/) ?? []
    return { ok: true, manifest: { id, name: id, version } }
  },
}))
// Bytes are read like any attachment's (lib/attachmentBytes): here, the URL's own text, said to arrive in two halves.
// A copy this device keeps is found by the bytes' sha256.
const kept = new Map<string, Blob>()
const download = vi.fn(async (source: { url: string }, ...rest: unknown[]) => {
  const progress = rest[3] as ((done: number, total: number) => void) | undefined
  progress?.(1, 2)
  progress?.(2, 2)
  return { status: 'ready', blob: new Blob([source.url]) }
})
vi.mock('../../lib/attachmentBytes', () => ({
  sourceKeyOf: (source: { url: string }) => `url:${source.url}`,
  attachmentBytes: (source: { url: string }, ...rest: unknown[]) => download(source, ...rest),
  cachedAttachmentCopy: async (sha256: string | null) => (sha256 ? kept.get(sha256) ?? null : null),
}))

const pkg = (id: string, version: string) => {
  const url = `https://files.test/${id}-${version}.guguext`
  return { fileName: `${id}.guguext`, messageId: `m-${id}-${version}`, source: { kind: 'url' as const, url } }
}

async function load() {
  vi.resetModules()
  getChatFiles.mockClear()
  download.mockClear()
  return import('./sharedPackages')
}

beforeEach(() => {
  files.clear()
  kept.clear()
})

describe('sharedPackagesOf', () => {
  it('everyone asking about one chat shares one read', async () => {
    const { sharedPackagesOf } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0')])
    const reads = await Promise.all([1, 2, 3].map(() => sharedPackagesOf('chat-1', 'me')))
    expect(getChatFiles).toHaveBeenCalledTimes(1)
    expect(reads.every((read) => read.get('vote')?.manifest.version === '1.0.0')).toBe(true)
  })

  it('a package sent in that chat: read again, and whoever listens is told — with no card of it on screen', async () => {
    const { packageArrived, sharedPackagesOf, subscribeSharedPackages } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0')])
    await sharedPackagesOf('chat-1', 'me')
    const told: string[] = []
    subscribeSharedPackages((chatId) => told.push(chatId))
    files.set('chat-1', [pkg('vote', '1.0.0'), pkg('vote', '1.1.0')])
    packageArrived('chat-1')
    expect(told).toEqual(['chat-1'])
    expect((await sharedPackagesOf('chat-1', 'me')).get('vote')?.manifest.version).toBe('1.1.0')
    expect(getChatFiles).toHaveBeenCalledTimes(2)
  })

  it('cards scrolling in and out, and a package sent in a chat nobody has read, cost nothing', async () => {
    const { packageArrived, sharedPackagesOf, showPackage, subscribeSharedPackages } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0')])
    await sharedPackagesOf('chat-1', 'me')
    const told: string[] = []
    subscribeSharedPackages((chatId) => told.push(chatId))
    const known = pkg('vote', '1.0.0')
    for (let i = 0; i < 5; i += 1) showPackage({ manifest: { id: 'vote', version: '1.0.0' } as never, card: { source: known.source, messageId: known.messageId } })()
    packageArrived('chat-2')
    expect(told).toEqual([])
    await sharedPackagesOf('chat-1', 'me')
    expect(getChatFiles).toHaveBeenCalledTimes(1)
  })
})

describe('summaryOf', () => {
  it('a copy this device keeps is read from disk: no download', async () => {
    const { summaryOf } = await load()
    const vote = pkg('vote', '1.0.0')
    kept.set('sha-vote', new Blob([vote.source.url]))
    expect(await summaryOf(vote, 'sha-vote')).toMatchObject({ ok: true, manifest: { id: 'vote', version: '1.0.0' } })
    expect(download).not.toHaveBeenCalled()
  })

  it('a download tells the cards watching it how far it has come, until they stop watching', async () => {
    const { summaryOf, watchReading } = await load()
    const vote = pkg('vote', '1.0.0')
    const seen: number[][] = []
    const stop = watchReading(vote, (done, total) => seen.push([done, total]))
    await summaryOf(vote, 'sha-not-kept')
    expect(seen).toEqual([[1, 2], [2, 2]])
    stop()
    const poll = pkg('poll', '1.0.0')
    watchReading(poll, () => undefined)()
    await summaryOf(poll)
    expect(seen).toHaveLength(2)
  })
})
