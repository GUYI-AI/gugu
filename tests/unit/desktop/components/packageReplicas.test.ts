// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('__APP_VERSION__', '9.9.9')

/**
 * One read of a chat's shared App packages at a time, shared by everyone who asks (摩擦单 F15's offer in the group's
 * panel; the widget's offer) — read again when a package is sent in that chat (摩擦单 F66: the account revision bus says
 * so, whatever is on screen). Replicas since PR 3 (@@@client-state-model).
 */

const files = new Map<string, { fileName: string; messageId: string; source: { kind: 'url'; url: string } }[]>()
const getChatFiles = vi.fn(async (chatId: string) => files.get(chatId) ?? [])
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getChatFiles: (chatId: string) => getChatFiles(chatId) } }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ warn: () => undefined, info: () => undefined }) }))
// A package's bytes are its URL here; its manifest is read from that: `…/<id>-<version>.guguext`.
vi.mock('../../../../apps/desktop/src/components/extensionBundle/summarizeExtensionBundle', () => ({
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
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({
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
  const replica = await import('../../../../apps/desktop/src/lib/replica')
  replica.followRendererSession('SIGNED_IN', 'me')
  replica.queryClient.clear()
  return { ...(await import('../../../../apps/desktop/src/components/extensionBundle/packageReplicas')), replica }
}

beforeEach(() => {
  files.clear()
  kept.clear()
})

describe('sharedAppPackages', () => {
  it('everyone asking about one chat shares one read; the newest package of each App, as an array', async () => {
    const { sharedAppPackages } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0'), pkg('vote', '1.1.0'), pkg('poll', '2.0.0')])
    const reads = await Promise.all([1, 2, 3].map(() => sharedAppPackages.fetch('chat-1')))
    expect(getChatFiles).toHaveBeenCalledTimes(1)
    expect(reads[0]!.map((shared) => [shared.appId, shared.manifest.version])).toEqual([['vote', '1.1.0'], ['poll', '2.0.0']])
  })

  it('a package sent in that chat (the log push): read again — with no card of it on screen', async () => {
    const { sharedAppPackages } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0')])
    await sharedAppPackages.fetch('chat-1')
    files.set('chat-1', [pkg('vote', '1.0.0'), pkg('vote', '1.2.0')])
    await sharedAppPackages.refresh('chat-1')
    expect((await sharedAppPackages.fetch('chat-1'))[0]!.manifest.version).toBe('1.2.0')
    expect(getChatFiles).toHaveBeenCalledTimes(2)
  })

  it('a chat that cannot be read is an error, ❌ "no packages here"', async () => {
    const { sharedAppPackages } = await load()
    getChatFiles.mockRejectedValueOnce(new Error('offline'))
    await expect(sharedAppPackages.fetch('chat-9')).rejects.toThrow('offline')
    expect(sharedAppPackages.peek('chat-9').state).toBe('error')
  })

  it('cards scrolling in and out cost nothing', async () => {
    const { sharedAppPackages, showPackage, shownPackages, newestShownPackage } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0')])
    await sharedAppPackages.fetch('chat-1')
    const known = pkg('vote', '1.0.0')
    for (let i = 0; i < 5; i += 1) showPackage({ manifest: { id: 'vote', version: '1.0.0' } as never, card: { source: known.source, messageId: known.messageId } })()
    expect(shownPackages.get().size).toBe(0)
    const take = showPackage({ manifest: { id: 'vote', version: '1.0.0' } as never, card: { source: known.source, messageId: known.messageId } })
    expect(newestShownPackage(shownPackages.get(), 'vote')?.manifest.version).toBe('1.0.0')
    take()
    await sharedAppPackages.fetch('chat-1')
    expect(getChatFiles).toHaveBeenCalledTimes(1)
  })
})

describe('extensionPackageSummary', () => {
  it('a copy this device keeps is read from disk: no download', async () => {
    const { extensionPackageSummary, noteKeptCopy } = await load()
    const vote = pkg('vote', '1.0.0')
    kept.set('sha-vote', new Blob([vote.source.url]))
    noteKeptCopy(`url:${vote.source.url}`, 'sha-vote')
    expect(await extensionPackageSummary.fetch(vote.source)).toMatchObject({ ok: true, manifest: { id: 'vote', version: '1.0.0' } })
    expect(download).not.toHaveBeenCalled()
  })

  it('a download says how far it has come to every card of the package, and leaves the store once read', async () => {
    const { extensionPackageSummary, packageProgress } = await load()
    const vote = pkg('vote', '1.0.0')
    const key = `url:${vote.source.url}`
    const seen: unknown[] = []
    const stop = packageProgress.subscribe(() => seen.push(packageProgress.get()[key] ?? null))
    expect(packageProgress.get()[key]).toBeUndefined()
    await extensionPackageSummary.fetch(vote.source)
    expect(seen).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }, null])
    stop()
  })

  it('a download that fails is the reading\'s error (read again on retry), ❌ kept as "unreadable"', async () => {
    const { extensionPackageSummary } = await load()
    const vote = pkg('vote', '1.0.0')
    download.mockRejectedValueOnce(new Error('network'))
    await expect(extensionPackageSummary.fetch(vote.source)).rejects.toThrow('network')
    expect(await extensionPackageSummary.fetch(vote.source)).toMatchObject({ ok: true })
  })
})

describe('a package whose bytes are not there (F1-4)', () => {
  it('is the reading\'s error, read again on retry (❌ remembered as unreadable for ever)', async () => {
    const { extensionPackageSummary } = await load()
    const vote = pkg('vote', '1.0.0')
    download.mockResolvedValueOnce({ status: 'expired' } as never)
    await expect(extensionPackageSummary.fetch(vote.source)).rejects.toThrow()
    expect(extensionPackageSummary.peek(vote.source).state).toBe('error')
    await extensionPackageSummary.refresh(vote.source)
    expect(await extensionPackageSummary.fetch(vote.source)).toMatchObject({ ok: true })
  })

  it('offers no App in the chat\'s list, the others still listed (❌ the whole list failed)', async () => {
    const { sharedAppPackages } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0'), pkg('poll', '2.0.0')])
    download.mockImplementationOnce(async () => ({ status: 'gone' }) as never)
    expect((await sharedAppPackages.fetch('chat-1')).map((shared) => shared.appId)).toEqual(['poll'])
  })

  it('a chat\'s list read across an account switch does not go on (❌ the summaries read and kept for the next account)', async () => {
    const { sharedAppPackages, replica } = await load()
    files.set('chat-1', [pkg('vote', '1.0.0')])
    let release!: () => void
    getChatFiles.mockImplementationOnce(async (chatId: string) => { await new Promise<void>((resolve) => { release = resolve }); return files.get(chatId) ?? [] })
    const read = sharedAppPackages.fetch('chat-1')
    await vi.waitFor(() => expect(getChatFiles).toHaveBeenCalled())
    replica.followRendererSession('SIGNED_IN', 'other')
    release()
    await expect(read).rejects.toThrow()
    expect(download).not.toHaveBeenCalled()
  })
})

describe('one summary per package, whoever asks', () => {
  // The card knows the message's sha256, a chat's list does not: both read the one entry of the package, one download.
  it('the card (with the bytes\' record) and the chat list (without) share one read', async () => {
    const { extensionPackageSummary, noteKeptCopy } = await load()
    const vote = pkg('vote', '2.0.0')
    const key = `url:${vote.source.url}`
    noteKeptCopy(key, 'sha-not-kept-here')
    await extensionPackageSummary.fetch(vote.source)
    await extensionPackageSummary.fetch(vote.source)
    expect(download).toHaveBeenCalledTimes(1)
  })
})

