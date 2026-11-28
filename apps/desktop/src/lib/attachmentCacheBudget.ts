/**
 * `gugu-attachments-v1` 的字节上限:Cache Storage 的 `keys()` 本身按写入先后排(同一个 key 重写会排到最后),条目大小读
 * `blob().size`(不读字节)—— 从最新往回,放得下的留着、放不下的删掉(`trimToBytes`,和桌面文件缓存共用的那一份)。❌ 另造索引或存储。
 * 淘汰按写入先后,不按读取(Cache API 不记读取时间);删掉的原图下次打开照常重新下载、校验。
 */
import { byteBudget, trimToBytes, type BudgetRole } from '@gugu/core/shared/byteBudget'

/** budget:计入上限;keep:不计入也不删(读到一半的续传分片);drop:直接删(崩溃留下的分片)。 */
export type CacheEntryRole = BudgetRole

/** 裁到上限以内,返回留下的(计入上限的)字节数。 */
export async function trimCacheToBytes(cache: Cache, maxBytes: number, roleOf: (url: string, response: Response) => CacheEntryRole): Promise<number> {
  return trimToBytes([...await cache.keys()].reverse(), maxBytes, async (request) => {
    const response = await cache.match(request)
    return response ? { role: roleOf(request.url, response), size: async () => (await response.blob()).size } : null
  }, async request => { await cache.delete(request) })
}

/**
 * 有上限的缓存的唯一写入口。比整个上限还大的那一份不进缓存(进了就得把别的全挤掉)。写入后不每次都扫(`byteBudget`):只在本次运行
 * 第一次写、或者超了上限时才裁。
 */
export function budgetedCacheWriter(open: () => Promise<Cache>, maxBytes: number, roleOf: (url: string, response: Response) => CacheEntryRole, onError: (error: unknown) => void) {
  const budget = byteBudget(maxBytes, async () => trimCacheToBytes(await open(), maxBytes, roleOf), onError)
  return {
    async put(request: RequestInfo | URL, body: Blob): Promise<void> {
      if (body.size > maxBytes) return
      await (await open()).put(request, new Response(body))
      budget.wrote(body.size)
    },
    /** 等在跑的那一次裁剪(没有就立即返回);不新起。 */
    idle: budget.idle,
  }
}
