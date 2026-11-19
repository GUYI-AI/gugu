import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_MISE_DOWNLOAD_BASE, defaultMiseCacheDir, obtainMiseArchive } from '../../../scripts/build/mise-archive-cache.mts'

// #6258 桌面构建内置的 mise 归档:按入库 sha256 内容寻址缓存,命中不访问网络;拿不到响亮失败并报出来源。
const CONTENT = 'fake mise archive bytes'
const SHA = createHash('sha256').update(CONTENT).digest('hex')
const ASSET = 'mise-v2026.9.12-macos-arm64.tar.gz'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-6258-'))
  roots.push(dir)
  return dir
}
const quiet = { log: () => {}, warn: () => {}, wait: () => {} }

describe('#6258 mise archive cache', () => {
  it('未命中:从来源拿一次、按 sha256/文件名 落缓存;再取即命中,不再访问网络', () => {
    const dir = cacheDir()
    const calls: string[] = []
    const download = (url: string, destination: string) => {
      calls.push(url)
      writeFileSync(destination, CONTENT)
    }
    const input = { cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, download, ...quiet }
    const first = obtainMiseArchive(input)
    expect(first).toBe(join(dir, SHA, ASSET))
    expect(calls).toEqual([`${DEFAULT_MISE_DOWNLOAD_BASE}/v2026.9.12/${ASSET}`])
    expect(obtainMiseArchive(input)).toBe(first)
    expect(calls).toHaveLength(1)
    expect(readdirSync(join(dir, SHA))).toEqual([ASSET]) // 没有 .part 残留
  })

  it('下载源可换(镜像),但只认入库的 sha256', () => {
    const dir = cacheDir()
    const calls: string[] = []
    obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, downloadBase: 'https://mirror.example/mise/',
      download: (url, destination) => { calls.push(url); writeFileSync(destination, CONTENT) }, ...quiet,
    })
    expect(calls).toEqual([`https://mirror.example/mise/v2026.9.12/${ASSET}`])
  })

  it('缓存坏了:丢弃、说出来、按 sha256 重拿', () => {
    const dir = cacheDir()
    mkdirSync(join(dir, SHA))
    writeFileSync(join(dir, SHA, ASSET), 'truncated')
    const warnings: string[] = []
    let downloads = 0
    const path = obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA,
      download: (_url, destination) => { downloads += 1; writeFileSync(destination, CONTENT) },
      log: () => {}, warn: (line) => warnings.push(line),
    })
    expect(downloads).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe(CONTENT)
    expect(warnings[0]).toMatch(/failed SHA-256, discarding/)
  })

  it('拿不到就响亮失败并报出来源;缓存里不留半截', () => {
    const dir = cacheDir()
    const brokenPipe = Object.assign(new Error('Command failed: curl'), { status: 55 })
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA,
      download: (_url, destination) => { writeFileSync(destination, 'partial'); throw brokenPipe }, ...quiet,
    })).toThrow(`[build-mise] download failed from ${DEFAULT_MISE_DOWNLOAD_BASE}/v2026.9.12/${ASSET} (curl exit 55)`)
    expect(existsSync(join(dir, SHA, ASSET))).toBe(false)
    expect(readdirSync(join(dir, SHA))).toEqual([])
  })

  it('来源给了别的内容 ⇒ 响亮失败(报来源与两个 sha),不入缓存', () => {
    const dir = cacheDir()
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA,
      download: (_url, destination) => writeFileSync(destination, 'tampered'), ...quiet,
    })).toThrow(`[build-mise] SHA-256 mismatch for ${ASSET} from ${DEFAULT_MISE_DOWNLOAD_BASE}/v2026.9.12/${ASSET}: got ${createHash('sha256').update('tampered').digest('hex')}, pinned ${SHA}`)
    expect(existsSync(join(dir, SHA, ASSET))).toBe(false)
  })

  it('缓存位置:CI 用 GUGU_MISE_CACHE_DIR,否则落在 XDG 缓存下', () => {
    expect(defaultMiseCacheDir({ GUGU_MISE_CACHE_DIR: '/ci/shared/mise', XDG_CACHE_HOME: '/x' })).toBe('/ci/shared/mise')
    expect(defaultMiseCacheDir({ XDG_CACHE_HOME: '/x' })).toBe(join('/x', 'gugu', 'mise'))
  })

  it.each([6, 7, 18, 28, 55, 56, 92])('curl %s 瞬时故障:只重试一次,不混入旧半截字节', (status) => {
    const dir = cacheDir()
    let calls = 0
    const waits: number[] = []
    const file = obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, ...quiet,
      wait: (milliseconds) => waits.push(milliseconds),
      download: (_url, destination) => {
        expect(existsSync(destination)).toBe(false)
        calls += 1
        writeFileSync(destination, calls === 1 ? 'partial' : CONTENT)
        if (calls === 1) throw Object.assign(new Error('transient transfer failure'), { status })
      },
    })
    expect(calls).toBe(2)
    expect(waits).toEqual([1000])
    expect(readFileSync(file, 'utf8')).toBe(CONTENT)
    expect(readdirSync(join(dir, SHA))).toEqual([ASSET])
  })

  it('主来源耗尽后走显式镜像,同 pin 校验;再次命中缓存时所有来源都不访问', () => {
    const dir = cacheDir()
    const calls: string[] = []
    const input = {
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, mirrorBase: 'https://upstream.example/mise', ...quiet,
      download: (url: string, destination: string) => {
        calls.push(url)
        if (url.startsWith(DEFAULT_MISE_DOWNLOAD_BASE)) throw Object.assign(new Error('timeout'), { status: 28 })
        writeFileSync(destination, CONTENT)
      },
    }
    const path = obtainMiseArchive(input)
    expect(calls).toEqual([`${DEFAULT_MISE_DOWNLOAD_BASE}/v2026.9.12/${ASSET}`, `${DEFAULT_MISE_DOWNLOAD_BASE}/v2026.9.12/${ASSET}`, `https://upstream.example/mise/v2026.9.12/${ASSET}`])
    expect(obtainMiseArchive(input)).toBe(path)
    expect(calls).toHaveLength(3)
  })

  it('两来源持续失败:最多四次,最终错误包括实际来源和退出码,不留缓存/半截', () => {
    const dir = cacheDir()
    let calls = 0
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, mirrorBase: 'https://upstream.example/mise', ...quiet,
      download: (_url, destination) => { calls += 1; writeFileSync(destination, 'partial'); throw Object.assign(new Error('reset'), { status: 56 }) },
    })).toThrow(`download failed from https://upstream.example/mise/v2026.9.12/${ASSET} (curl exit 56), attempt 2/2`)
    expect(calls).toBe(4)
    expect(readdirSync(join(dir, SHA))).toEqual([])
  })

  it.each([{ status: 22, httpStatus: 404 }, { status: 60 }, { status: 23 }, { code: 'EACCES' }])('HTTP/TLS/本地持久故障立即失败,不重试或换源: %j', (fields) => {
    const dir = cacheDir()
    let calls = 0
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, mirrorBase: 'https://upstream.example/mise', ...quiet,
      download: () => { calls += 1; throw Object.assign(new Error('persistent failure'), fields) },
    })).toThrow('download failed from ' + DEFAULT_MISE_DOWNLOAD_BASE)
    expect(calls).toBe(1)
  })

  it('镜像返回错误字节时立即失败,不再重试到绿', () => {
    const dir = cacheDir()
    let calls = 0
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, mirrorBase: 'https://upstream.example/mise', ...quiet,
      download: (_url, destination) => {
        calls += 1
        if (calls <= 2) throw Object.assign(new Error('timeout'), { status: 28 })
        writeFileSync(destination, 'tampered')
      },
    })).toThrow('SHA-256 mismatch')
    expect(calls).toBe(3)
    expect(readdirSync(join(dir, SHA))).toEqual([])
  })

  it('下载成功后归档消失:给出校验阶段/路径和隔离排查提示,不当网络错误重新下载', () => {
    const dir = cacheDir()
    let calls = 0
    let partial = ''
    let failure: unknown
    try {
      obtainMiseArchive({
        cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, mirrorBase: 'https://upstream.example/mise', ...quiet,
        download: (_url, destination) => { calls += 1; partial = destination; writeFileSync(destination, CONTENT); rmSync(destination) },
      })
    } catch (error) { failure = error }
    expect(String(failure)).toContain('SHA-256 verification after download from ' + DEFAULT_MISE_DOWNLOAD_BASE)
    expect(String(failure)).toContain(partial)
    expect(String(failure)).toContain('ENOENT')
    expect(String(failure)).toContain('endpoint-security/quarantine records; this filesystem error will not trigger a retry or mirror')
    expect(calls).toBe(1)
    expect(readdirSync(join(dir, SHA))).toEqual([])
  })

  it('现有缓存不可读:指出缓存校验阶段,保留现场且不访问网络', () => {
    const dir = cacheDir()
    const cached = join(dir, SHA, ASSET)
    mkdirSync(cached, { recursive: true }) // readFileSync fails with EISDIR.
    let downloads = 0
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, ...quiet,
      download: () => { downloads += 1 },
    })).toThrow(`cannot read archive during cache verification: ${cached}`)
    expect(downloads).toBe(0)
    expect(existsSync(cached)).toBe(true)
  })
})
