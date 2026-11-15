import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { mkdir, open, readFile, readdir, rm, appendFile, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHistoryFixture, VISIBLE_MARKER } from './native-history-fixture.mts'
import { assertAcceptanceScope } from './native-history-safety.mts'
const { values } = parseArgs({ options: { root: { type: 'string' }, 'source-root': { type: 'string' },
  sha: { type: 'string' }, bytes: { type: 'string', default: String(5 * 1024 ** 3) },
  provider: { type: 'string', default: 'both' }, variant: { type: 'string', default: 'all' },
  host: { type: 'string' }, probe: { type: 'string' }, timeout: { type: 'string', default: '10000' } } })
const execute = promisify(execFile), here = dirname(fileURLToPath(import.meta.url))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function readable(value, marker) {
  const page = value?.result?.snapshot ?? value?.result?.batch ?? value?.snapshot ?? value?.batch ?? value
  return page?.sourceFragments?.some(fragment => fragment.text?.includes(marker)) ? page : null
}
if (values.probe) {
  const data = JSON.parse(await readFile(values.probe, 'utf8'))
  const { createDesktopSourceWindowReader } = await import(pathToFileURL(join(data.sourceRoot,
    'apps/desktop/electron/session/main/core/session-timeline/desktop-source-reader.ts')).href)
  const { createWindowBudget } = await import(pathToFileURL(join(data.sourceRoot,
    'packages/session-core/src/session-record/window-cache/read-budget.ts')).href)
  const phases = { window: {}, discovery: {}, reverse: {} }, errors = []
  const recordPhase = (io, phase) => { for (const [key, count] of Object.entries(io)) phases[phase][key] = (phases[phase][key] || 0) + count }
  const reader = createDesktopSourceWindowReader({
    request: async (id, limit, signal) => ({ conversationId: id,
      locator: { harness: data.provider, providerSessionId: data.nativeId, roots: [data.nativeRoot] },
      cacheDirectory: data.cacheDirectory, cwd: data.cwd, scope: hash([data.root, data.nativeId]),
      conversationScope: hash(data.conversationId), branchLineage: hash([data.provider, data.nativeId]),
      limit, signal, budget: createWindowBudget() }),
    reportError: error => { if (errors.length < 8) errors.push(String(error)) },
    observed: (_id, io, phase = 'window') => recordPhase(io, phase),
    backgroundRead: (_jobId, io) => recordPhase(io, 'reverse'),
  })
  let stop, timer, value = null, firstReadableRpcMs = null, error = null
  const started = performance.now()
  try {
    const first = await reader.snapshot({ conversationId: data.conversationId, limit: 20 })
    if (readable(first, data.marker)) value = first
    else value = await new Promise((yes, no) => {
      timer = setTimeout(() => no(new Error('Test deadline: no readable RPC body; not an absence/size decision')), data.timeout)
      reader.subscribe({ conversationId: data.conversationId, subscriptionId: 'c-fixture', cursor: first.cursor },
        event => { if (readable(event, data.marker)) yes(event) }, no).then(unsubscribe => { stop = unsubscribe }, no)
    })
    firstReadableRpcMs = performance.now() - started
  } catch (failure) { error = String(failure) }
  const independentIoThroughRpcObserver = globalThis.__guguHistoryIoTrace?.snapshot() ?? null
  clearTimeout(timer); stop?.(); await reader.dispose()
  const result = { evidence: 'source_host_service_bridge_not_electron_paint', sourceSha: data.sha,
    provider: data.provider, variant: data.variant, logicalBytes: data.bytes, firstReadableRpcMs,
    readable: value !== null, rpcResultBytes: value ? Buffer.byteLength(JSON.stringify(value)) : null,
    phases, independentIoThroughRpcObserver, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    node: process.version, platform: process.platform, error, backgroundErrors: errors,
    missingLayers: ['outer service.ts DB registration', 'controller.ts IPC envelope', 'Electron renderer paint'] }
  process.stdout.write(JSON.stringify(result) + '\n')
} else {
  const bytes = Number(values.bytes), timeout = Number(values.timeout), root = resolve(values.root || '')
  if (!values.root || !values['source-root'] || !/^[a-f0-9]{40}$/.test(values.sha || '') ||
      !Number.isSafeInteger(bytes) || bytes < 128 * 1024 || !Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Explicit root/source-root/full SHA and fixture size >=128KiB required')
  process.env.GUGU_ACCEPTANCE_HOST = values.host || ''
  if (bytes >= 100_000_000) await assertAcceptanceScope(values.host || '')
  const sourceRoot = resolve(values['source-root'])
  const pin = JSON.parse(await readFile(join(sourceRoot, 'PIN.json'), 'utf8'))
  if (pin.sha !== values.sha) throw new Error('Source SHA does not match manifest')
  for (const [name, expected] of Object.entries(pin.files)) {
    const actual = createHash('sha256').update(await readFile(join(sourceRoot, name))).digest('hex')
    if (actual !== expected) throw new Error(`Pinned source hash mismatch: ${name}`)
  }
  const providers = values.provider === 'both' ? ['claude', 'codex'] : [values.provider]
  const variants = values.variant === 'all' ? ['normal', 'empty-text', 'metadata70k'] : [values.variant]
  if (providers.some(value => !['claude', 'codex'].includes(value)) ||
      variants.some(value => !['normal', 'empty-text', 'metadata70k'].includes(value))) throw new Error('Invalid scenario')
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length) throw new Error('The run directory must be empty')
  const report = join(root, 'host-samples.jsonl'), manifest = join(root, 'created-files.jsonl')
  const samples = []
  for (const provider of providers) for (const variant of variants) {
    const directory = join(root, `${provider}-${variant}-${randomUUID()}`), nativeId = randomUUID()
    const cwd = join(directory, 'project'), nativeRoot = join(directory, 'native')
    const leaf = provider === 'claude' ? join(nativeRoot, cwd.replace(/[^a-zA-Z0-9]/g, '-')) : join(nativeRoot, '2026', '11', '08')
    await mkdir(leaf, { recursive: true }); await mkdir(cwd)
    const file = join(leaf, provider === 'claude' ? `${nativeId}.jsonl` : `rollout-2026-11-08T00-00-00-${nativeId}.jsonl`)
    const marker = `RECENT-2062: ${provider}/${variant} 中文 🐾`
    const content = [{ type: provider === 'claude' ? 'text' : 'output_text',
      text: variant === 'empty-text' ? marker + '\n' + 'x'.repeat(128 * 1024) : marker }]
    if (variant === 'empty-text') content.unshift({ type: provider === 'claude' ? 'text' : 'output_text', text: '' })
    const padding = variant === 'metadata70k' ? { metadata: 'm'.repeat(70 * 1024) } : {}
    const tail = Buffer.from(JSON.stringify(provider === 'claude'
      ? { type: 'assistant', uuid: nativeId, ...padding, message: { role: 'assistant', content } }
      : { type: 'response_item', ...padding, payload: { type: 'message', role: 'assistant', content } }) + '\n')
    const timestamp = new Date(Date.UTC(2026, 0, 1) + 100 * 3600_000).toISOString()
    const originalTail = Buffer.from(JSON.stringify(provider === 'claude'
      ? { type: 'user', uuid: 'synthetic-1000000000', parentUuid: null, timestamp, message: { role: 'user', content: VISIBLE_MARKER } }
      : { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: VISIBLE_MARKER }] } }) + '\n')
    await appendFile(manifest, JSON.stringify({ operation: 'create', file, bytes }) + '\n')
    try {
      const generatedBytes = bytes - tail.length + originalTail.length
      await createHistoryFixture(file, generatedBytes, 'valid-jsonl', provider)
      const handle = await open(file, 'r+')
      try { const start = generatedBytes - originalTail.length; await handle.truncate(start); await handle.write(tail, 0, tail.length, start); await handle.sync() }
      finally { await handle.close() }
      const data = { root: directory, sourceRoot, sha: values.sha, provider, variant, bytes, file, nativeId, nativeRoot, cwd,
        conversationId: randomUUID(), cacheDirectory: join(directory, 'profile', 'user-data', 'session-window-cache'), marker, timeout }
      const config = join(directory, 'case.json'); await writeFile(config, JSON.stringify(data))
      const env = { ...process.env, GUGU_HISTORY_SOURCE_ROOT: sourceRoot, GUGU_HISTORY_SOURCE_SHA: values.sha,
        GUGU_HOME: join(directory, 'profile', 'home'), GUGU_USER_DATA_DIR: join(directory, 'profile', 'user-data'),
        GUGU_HISTORY_IO_TRACE: JSON.stringify({ sources: [file], caches: [data.cacheDirectory], outputDirectory: join(directory, 'trace') }) }
      const measured = await execute(process.execPath, ['--experimental-transform-types', '--import', join(here, 'native-history-source-loader.mjs'),
        '--require', join(here, 'native-history-io-preload.cjs'), fileURLToPath(import.meta.url), '--probe', config],
      { env, maxBuffer: 512 * 1024, timeout: timeout + 15000 })
      const sample = JSON.parse(measured.stdout); samples.push(sample)
      await writeFile(join(directory, 'probe.stderr'), measured.stderr)
      await appendFile(report, JSON.stringify(sample) + '\n')
      process.stdout.write(JSON.stringify(sample) + '\n')
    } catch (failure) {
      const failed = { provider, variant, sourceSha: values.sha, error: String(failure), stdout: failure.stdout, stderr: failure.stderr }
      samples.push(failed)
      await appendFile(report, JSON.stringify(failed) + '\n'); process.stdout.write(JSON.stringify(failed) + '\n')
    } finally {
      await rm(file, { force: true }); await appendFile(manifest, JSON.stringify({ operation: 'removed', file }) + '\n')
    }
  }
  const summary = { sourceSha: values.sha, cases: samples.length, readable: samples.filter(sample => sample.readable === true).length, report }
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary))
  process.stdout.write(JSON.stringify({ summary }) + '\n')
  if (summary.readable !== summary.cases) process.exitCode = 1
}
