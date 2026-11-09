// 附件缓存的字节上限,在真 Cache Storage 上量:超了删最旧的,刚写入的还在;比整个上限还大的一份不进缓存、不挤掉别的;
// 只算留下的;读到一半的续传分片不计入、不删,崩溃留下的分片删掉;写入不每次都扫。
import { afterEach, describe, expect, it } from 'vitest'
import { budgetedCacheWriter, trimCacheToBytes, type CacheEntryRole } from '@/lib/attachmentCacheBudget'

const NAME = 'attachment-cache-budget-test'
const ORIGIN = 'https://attachments.gugu.invalid'
const bytes = (n: number) => new Blob([new Uint8Array(n)])
const open = () => caches.open(NAME)
const names = async () => (await (await open()).keys()).map((r) => r.url.replace(ORIGIN, ''))
const byPrefix = (url: string, response: Response): CacheEntryRole =>
  !url.startsWith(`${ORIGIN}/chunks/`) ? 'budget' : response.headers.get('x-live') ? 'keep' : 'drop'
const fail = (error: unknown) => { throw error }

afterEach(async () => { await caches.delete(NAME) })

describe('attachment cache byte budget', () => {
  it('drops the oldest entries past the budget and keeps the newest', async () => {
    const writer = budgetedCacheWriter(open, 1000, byPrefix, fail)
    for (const name of ['a', 'b', 'c', 'd']) { await writer.put(`${ORIGIN}/sha256/${name}`, bytes(400)); await writer.idle() }
    expect(await names()).toEqual(['/sha256/c', '/sha256/d'])
  })

  it('rewriting an entry makes it the newest', async () => {
    const cache = await open()
    for (const name of ['a', 'b', 'c']) await cache.put(`${ORIGIN}/sha256/${name}`, new Response(bytes(400)))
    await cache.put(`${ORIGIN}/sha256/a`, new Response(bytes(400)))
    await trimCacheToBytes(cache, 800, byPrefix)
    expect(await names()).toEqual(['/sha256/c', '/sha256/a'])
  })

  it('never stores one file larger than the whole budget, and keeps everything else', async () => {
    const writer = budgetedCacheWriter(open, 1000, byPrefix, fail)
    for (const name of ['a', 'b']) { await writer.put(`${ORIGIN}/sha256/${name}`, bytes(300)); await writer.idle() }
    await writer.put(`${ORIGIN}/sha256/video`, bytes(1001))
    await writer.idle()
    expect(await names()).toEqual(['/sha256/a', '/sha256/b'])
  })

  it('counts only what it keeps: an older entry that still fits stays', async () => {
    const cache = await open()
    await cache.put(`${ORIGIN}/sha256/small`, new Response(bytes(100)))
    await cache.put(`${ORIGIN}/sha256/big`, new Response(bytes(600)))
    await cache.put(`${ORIGIN}/sha256/newest`, new Response(bytes(500)))
    expect(await trimCacheToBytes(cache, 1000, byPrefix)).toBe(600)
    expect(await names()).toEqual(['/sha256/small', '/sha256/newest'])
  })

  it('keeps in-flight chunks out of the budget and deletes orphaned ones', async () => {
    const cache = await open()
    await cache.put(`${ORIGIN}/chunks/live/0`, new Response(bytes(5000), { headers: { 'x-live': '1' } }))
    await cache.put(`${ORIGIN}/chunks/orphan/0`, new Response(bytes(5000)))
    for (const name of ['a', 'b']) await cache.put(`${ORIGIN}/sha256/${name}`, new Response(bytes(400)))
    await trimCacheToBytes(cache, 500, byPrefix)
    expect(await names()).toEqual(['/chunks/live/0', '/sha256/b'])
  })

  it('measures once per run, then rescans only when a write goes over the budget', async () => {
    let scans = 0
    const writer = budgetedCacheWriter(open, 1000, (url, response) => { scans += 1; return byPrefix(url, response) }, fail)
    for (const name of ['a', 'b', 'c']) { await writer.put(`${ORIGIN}/sha256/${name}`, bytes(300)); await writer.idle() }
    // The first write measured the cache (one entry); the next two stayed under the budget and scanned nothing.
    expect(scans).toBe(1)
    await writer.put(`${ORIGIN}/sha256/d`, bytes(300))
    await writer.idle()
    expect(scans).toBe(1 + 4)
    expect(await names()).toEqual(['/sha256/b', '/sha256/c', '/sha256/d'])
  })
})
