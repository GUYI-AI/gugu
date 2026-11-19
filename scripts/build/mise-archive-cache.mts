// @@@mise-archive-cache (#6258) — 内置 mise 归档按「sha256 / 文件名」内容寻址存一份,命中就不访问网络。
//
// 每次构建从自有 vendor 存储取固定归档,一次断连(curl 55 Broken pipe)就把 required 聚合打红;
// 版本与 sha256 早已入库(mise-release.json),缺的是「拿过一次就别再拿」。CI 上由 setup-ci-slot 指到
// 全机共用的 ~/.gugu-ci-shared/mise(16 个槽共一份,理由同 fixture-bin #5360);本地落在 XDG 缓存下。
// #3203: 瞬时传输错误每个来源最多两次,之后才用调用方显式指定的官方镜像;每份字节都必须匹配同一个 pin。
// 哈希错误、TLS/本地文件错误不重试、不换源;下载后读不到归档时明确提示检查文件系统/隔离记录。
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_MISE_DOWNLOAD_BASE: string = 'https://download.gugu.nextmind.space/releases/vendor/mise'
export const MISE_UPSTREAM_DOWNLOAD_BASE: string = 'https://github.com/jdx/mise/releases/download'

export function defaultMiseCacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.GUGU_MISE_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'gugu', 'mise')
}

function sha256Of(file: string, stage: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException
    throw new Error(`[build-mise] cannot read archive during ${stage}: ${file} (${error.code ?? error.message}); inspect filesystem permissions and endpoint-security/quarantine records; this filesystem error will not trigger a retry or mirror`, { cause })
  }
}

type DownloadError = { status?: number; httpStatus?: number; stdout?: string | Buffer; message?: string }
// https://curl.se/libcurl/c/libcurl-errors.html and https://curl.se/docs/manpage.html#--retry
const transientCurlErrors = new Set([5, 6, 7, 16, 18, 28, 52, 55, 56, 92, 95])
const transientHttpErrors = new Set([408, 429, 500, 502, 503, 504, 522, 524])
const pause = (milliseconds: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds) }

function transient(error: DownloadError): boolean {
  return error.status === 22 ? transientHttpErrors.has(error.httpStatus ?? 0) : transientCurlErrors.has(error.status ?? 0)
}

function describe(error: DownloadError): string {
  return error.status === undefined ? String(error.message ?? error) : `curl exit ${error.status}${error.httpStatus ? `, HTTP ${error.httpStatus}` : ''}`
}

function curlDownload(url: string, destination: string): void {
  try {
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '0', '--connect-timeout', '15', '--max-time', '180', '--speed-limit', '1', '--speed-time', '60', '--write-out', '%{http_code}', '--output', destination, url], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
  } catch (cause) {
    const error = cause as DownloadError
    error.httpStatus = Number(String(error.stdout ?? '').trim()) || undefined
    throw cause
  }
}

/** 返回校验过的归档路径(在缓存里)。缓存命中不调用 `download`。 */
export function obtainMiseArchive({
  cacheDir,
  downloadBase = DEFAULT_MISE_DOWNLOAD_BASE,
  mirrorBase,
  version,
  asset,
  sha256,
  download = curlDownload,
  wait = pause,
  log = console.log,
  warn = console.error,
}: {
  cacheDir: string
  downloadBase?: string
  mirrorBase?: string
  version: string
  asset: string
  sha256: string
  download?: (url: string, destination: string) => void
  wait?: (milliseconds: number) => void
  log?: (line: string) => void
  warn?: (line: string) => void
}): string {
  const cached = join(cacheDir, sha256, asset)
  if (existsSync(cached)) {
    if (sha256Of(cached, 'cache verification') === sha256) {
      log('[build-mise] cache hit ' + cached)
      return cached
    }
    // 缓存坏了(截断/被改)不是「用它凑合」的理由:删掉、说出来,再按入库的 sha256 重拿一份。
    warn('[build-mise] cached archive failed SHA-256, discarding: ' + cached)
    rmSync(cached, { force: true })
  }
  mkdirSync(dirname(cached), { recursive: true })
  const urls = [...new Set([downloadBase, ...(mirrorBase ? [mirrorBase] : [])].map(base => base.replace(/\/+$/, '') + '/v' + version + '/' + asset))]
  const partial = cached + '.' + process.pid + '.' + randomUUID() + '.part'
  for (const [source, url] of urls.entries()) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        try {
          download(url, partial)
        } catch (cause) {
          const error = (cause ?? {}) as DownloadError
          const retryable = transient(error)
          const message = `[build-mise] download failed from ${url} (${describe(error)}), attempt ${attempt}/2; nothing cached at ${cached}`
          if (!retryable || (attempt === 2 && source === urls.length - 1)) throw new Error(message, { cause })
          // 先清半截;无法清理属于本地文件故障,不能再下载或换源掩盖。
          try { rmSync(partial, { force: true }) } catch (cleanupError) {
            throw new Error(`[build-mise] cannot remove partial archive before retry: ${partial}; inspect filesystem permissions and endpoint-security/quarantine records`, { cause: cleanupError })
          }
          warn(message + (attempt < 2 ? '; retrying once' : '; trying explicitly configured mirror'))
          wait(1000)
          continue
        }
        const actual = sha256Of(partial, `SHA-256 verification after download from ${url}`)
        if (actual !== sha256) throw new Error('[build-mise] SHA-256 mismatch for ' + asset + ' from ' + url + ': got ' + actual + ', pinned ' + sha256)
        // 内容寻址 + 原子发布:缓存永远不会指向未校验的半截归档。
        renameSync(partial, cached)
        log('[build-mise] downloaded ' + url + ' → ' + cached)
        return cached
      } finally {
        try { rmSync(partial, { force: true }) } catch (error) { warn(`[build-mise] could not remove partial archive ${partial}: ${String(error)}`) }
      }
    }
  }
  throw new Error('[build-mise] archive sources exhausted: ' + asset)
}
