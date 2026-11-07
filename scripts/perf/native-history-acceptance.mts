import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { assertAcceptanceScope, assertLegacySize } from './native-history-safety.mts'
import { createHistoryFixture, VISIBLE_MARKER, type FixtureKind, type Provider } from './native-history-fixture.mts'

type Sample = {
  evidence: 'reader' | 'desktop'; firstFrameMs: number; firstReadablePaintMs: number | null;
  readableText: string; placeholder: boolean; durableImportLocator: boolean;
  cacheState: string; sourceBytes: number; indexBytes: number; decodedBytes: number; outputBytes: number;
  background?: { bytes: number; elapsedMs: number; resumedFrom: number; maximumTaskMs: number };
}
export function validateSample(sample: Sample, kind: FixtureKind, cacheState: string, desktop: boolean): void {
  for (const field of ['firstFrameMs', 'sourceBytes', 'indexBytes', 'decodedBytes', 'outputBytes'] as const) {
    if (!Number.isFinite(sample[field]) || sample[field] < 0) throw new Error(`Missing physical measurement: ${field}`)
  }
  if (desktop && sample.evidence !== 'desktop') throw new Error('A reader result cannot establish desktop first paint')
  if (sample.cacheState !== cacheState) throw new Error('Wrong cache scenario')
  if (sample.sourceBytes > 512 * 1024 || sample.indexBytes > 64 * 1024 || sample.decodedBytes > 512 * 1024 || sample.outputBytes > 128 * 1024) {
    throw new Error('Aggregate foreground byte budget exceeded')
  }
  if (kind !== 'legacy-giant') {
    if (sample.placeholder || sample.firstReadablePaintMs === null || !Number.isFinite(sample.firstReadablePaintMs) || sample.firstReadablePaintMs < 0 || !sample.readableText.includes(VISIBLE_MARKER)) {
      throw new Error('Current readable content is required; a placeholder is not first readable paint')
    }
    if (kind === 'valid-jsonl' && !sample.durableImportLocator) throw new Error('Use the actual capture/import locator path')
  } else {
    if (sample.durableImportLocator) throw new Error('Unknown-start legacy evidence must not receive an invented locator')
    for (const field of ['bytes', 'elapsedMs', 'resumedFrom', 'maximumTaskMs'] as const) {
      const amount = sample.background?.[field]
      if (typeof amount !== 'number' || !Number.isFinite(amount) || (field === 'maximumTaskMs' ? amount < 0 : amount <= 0)) {
        throw new Error(`Missing actual background discovery/resume measurement: ${field}`)
      }
      if ((field === 'bytes' || field === 'resumedFrom') && !Number.isSafeInteger(amount)) throw new Error('Invalid background byte offset')
    }
  }
}
/** Only inspect this process and descendants; never inspect unrelated process command lines. */
async function treeRss(pid: number): Promise<number> {
  try {
    const [status, children] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'),
    ])
    const own = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024
    const childBytes = await Promise.all(children.trim().split(/\s+/).filter(Boolean).map(child => treeRss(Number(child))))
    return own + childBytes.reduce((sum, bytes) => sum + bytes, 0)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
}
export async function runAcceptance(options: {
  expectedHost: string; directory: string; adapter: string; kind: FixtureKind; provider: Provider;
  desktop: boolean; legacy: boolean; samples: number;
}) {
  const cgroup = await assertAcceptanceScope(options.expectedHost)
  process.env.GUGU_ACCEPTANCE_HOST = options.expectedHost
  // No fallback implementation: an actual product adapter is required before creating any fixture.
  const adapter = await import(pathToFileURL(resolve(options.adapter)).href)
  if (typeof adapter.prepareCase !== 'function' || typeof adapter.runCase !== 'function' || typeof adapter.closeCase !== 'function') {
    throw new Error('Adapter must supply actual prepareCase/runCase/closeCase entry points')
  }
  const sizes = options.kind === 'legacy-giant' ? [600 * 1024 ** 2] : [10 * 1024 ** 2, 5 * 1024 ** 3, 20 * 1024 ** 3]
  if (options.legacy) sizes.forEach(assertLegacySize) // Refuse the whole old-path matrix before fixture generation.
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > 10) throw new Error('Invalid sample count')
  await mkdir(options.directory, { recursive: true })
  const root = await mkdtemp(join(resolve(options.directory), 'native-history-2062-'))
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const report = join(root, 'measurements.jsonl')
  await writeFile(join(root, 'run.json'), JSON.stringify({ ...options, sha, cgroup, node: process.version }))
  for (const bytes of sizes) {
    const fixture = join(root, 'source.jsonl')
    const profile = await mkdtemp(join(root, 'profile-'))
    const env = { ...process.env, GUGU_HOME: join(profile, 'home'), GUGU_USER_DATA_DIR: join(profile, 'user-data') }
    let state: unknown
    try {
      const metadata = await createHistoryFixture(fixture, bytes, options.kind, options.provider)
      state = await adapter.prepareCase({ sourcePath: fixture, profile, env, metadata, signal: AbortSignal.timeout(600_000) })
      for (const cacheState of options.kind === 'legacy-giant' ? ['absent'] : ['valid', 'absent', 'corrupt']) {
        for (let iteration = 0; iteration < options.samples; iteration++) {
          let rssPeak = await treeRss(process.pid)
          let samplingError: unknown
          let polling: Promise<void> | null = null
          const sampler = setInterval(() => {
            if (polling) return
            polling = treeRss(process.pid).then(rss => { rssPeak = Math.max(rssPeak, rss) }, error => { samplingError = error }).finally(() => { polling = null })
          }, 10)
          let sample: Sample
          try {
            sample = await adapter.runCase({ state, sourcePath: fixture, env, cacheState, iteration,
              legacy: options.legacy, signal: AbortSignal.timeout(180_000) })
            rssPeak = Math.max(rssPeak, await treeRss(process.pid))
          } finally { clearInterval(sampler); await polling }
          if (samplingError) throw samplingError
          let validationError: string | null = null
          try { validateSample(sample, options.kind, cacheState, options.desktop) } catch (error) { validationError = String(error) }
          const scopePeak = Number((await readFile(join(cgroup, 'memory.peak'), 'utf8')).trim())
          await appendFile(report, JSON.stringify({ sha, kind: options.kind, provider: options.provider, bytes,
            requestedCacheState: cacheState, iteration, ...sample, validationError, sampledProcessTreeRssPeak: rssPeak,
            scopeMemoryPeakIncludingFixtureAndPageCache: scopePeak }) + '\n')
          if (validationError) throw new Error(validationError)
        }
      }
    } finally {
      try { await adapter.closeCase({ state, profile }) }
      finally { await rm(fixture, { force: true }); await rm(profile, { recursive: true, force: true }) }
    }
  }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'expected-host': { type: 'string' }, directory: { type: 'string' }, adapter: { type: 'string' },
    kind: { type: 'string', default: 'sparse-io' }, provider: { type: 'string', default: 'codex' },
    desktop: { type: 'boolean', default: true }, legacy: { type: 'boolean', default: false }, samples: { type: 'string', default: '3' },
  } })
  if (!values.directory || !values.adapter || !['sparse-io', 'valid-jsonl', 'legacy-giant'].includes(values.kind!) || !['claude', 'codex'].includes(values.provider!)) throw new Error('Missing or invalid acceptance arguments')
  process.stdout.write(await runAcceptance({ expectedHost: values['expected-host'] || '', directory: values.directory,
    adapter: values.adapter, kind: values.kind as FixtureKind, provider: values.provider as Provider,
    desktop: values.desktop!, legacy: values.legacy!, samples: Number(values.samples) }) + '\n')
}
