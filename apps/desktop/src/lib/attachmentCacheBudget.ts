/**
 * `gugu-attachments-v1` 的字节上限:Cache Storage 的 `keys()` 本身按写入先后排(同一个 key 重写会排到最后),条目大小读
 * `blob().size`(不读字节)—— 从最新往回,放得下的留着、放不下的删掉。❌ 另造索引或存储。
 * 淘汰按写入先后,不按读取(Cache API 不记读取时间);删掉的原图下次打开照常重新下载、校验。
 */
/** budget:计入上限;keep:不计入也不删(读到一半的续传分片);drop:直接删(崩溃留下的分片)。 */
export type CacheEntryRole = 'budget' | 'keep' | 'drop'

/** 裁到上限以内,返回留下的(计入上限的)字节数。 */
export async function trimCacheToBytes(cache: Cache, maxBytes: number, roleOf: (url: string, response: Response) => CacheEntryRole): Promise<number> {
  const requests = await cache.keys()
  let kept = 0
  for (let i = requests.length - 1; i >= 0; i--) {
    const request = requests[i]!
    const response = await cache.match(request)
    if (!response) continue
    const role = roleOf(request.url, response)
    if (role === 'keep') continue
    const size = role === 'drop' ? 0 : (await response.blob()).size
    if (role === 'drop' || kept + size > maxBytes) await cache.delete(request)
    else kept += size
  }
  return kept
}

/**
 * 有上限的缓存的唯一写入口。比整个上限还大的那一份不进缓存(进了就得把别的全挤掉)。写入后不每次都扫:记着上次裁完的字节数加上
 * 之后写入的,只在本次运行第一次写、或者超了上限时才裁(裁着的时候又来的写入合成下一轮)。
 */
export function budgetedCacheWriter(open: () => Promise<Cache>, maxBytes: number, roleOf: (url: string, response: Response) => CacheEntryRole, onError: (error: unknown) => void) {
  let knownBytes: number | null = null
  let trimming: Promise<void> | null = null, again = false
  const trim = (): Promise<void> => {
    if (trimming) { again = true; return trimming }
    trimming = (async () => {
      do { again = false; knownBytes = await trimCacheToBytes(await open(), maxBytes, roleOf) } while (again)
    })().finally(() => { trimming = null })
    return trimming
  }
  return {
    async put(request: RequestInfo | URL, body: Blob): Promise<void> {
      if (body.size > maxBytes) return
      await (await open()).put(request, new Response(body))
      if (knownBytes !== null) knownBytes += body.size
      if (knownBytes === null || knownBytes > maxBytes) void trim().catch(onError)
    },
    /** 等在跑的那一次裁剪(没有就立即返回);不新起。 */
    idle: (): Promise<void> => trimming ?? Promise.resolve(),
  }
}
