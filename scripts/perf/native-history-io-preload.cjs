// Test-only preload. No work occurs without an explicit, isolated fixture configuration.
if (process.env.GUGU_HISTORY_IO_TRACE) {
  const fs = require('node:fs')
  const promises = require('node:fs/promises')
  const path = require('node:path')
  const { syncBuiltinESMExports } = require('node:module')
  const config = JSON.parse(process.env.GUGU_HISTORY_IO_TRACE)
  if (!Array.isArray(config.sources) || !Array.isArray(config.caches) || !path.isAbsolute(config.outputDirectory) ||
      ![...config.sources, ...config.caches].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('History trace requires explicit absolute fixture/cache/output paths')
  }
  const canonical = value => {
    let candidate = path.resolve(String(value)); const suffix = []
    for (;;) {
      try { return path.join(fs.realpathSync(candidate), ...suffix) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        const parent = path.dirname(candidate)
        if (parent === candidate) throw error
        suffix.unshift(path.basename(candidate)); candidate = parent
      }
    }
  }
  const descriptors = new Map(), handles = new WeakMap()
  const sources = new Set(config.sources.map(canonical)), caches = config.caches.map(canonical)
  const classify = value => {
    if (typeof value === 'number') {
      const entry = descriptors.get(value)
      if (entry?.handle.fd === value) return entry.kind
      descriptors.delete(value); return null
    }
    if (value && typeof value === 'object' && handles.has(value)) return handles.get(value)
    if (typeof value !== 'string' && !(value instanceof URL) && !Buffer.isBuffer(value)) return null
    const name = canonical(value instanceof URL ? require('node:url').fileURLToPath(value) : String(value))
    if (sources.has(name)) return 'source'
    if (caches.some(root => name.startsWith(root + path.sep))) return 'index'
    return null
  }
  fs.mkdirSync(config.outputDirectory, { recursive: true })
  const output = path.join(config.outputDirectory, `history-io-${process.pid}.json`)
  const write = fs.writeFileSync.bind(fs)
  const stats = { pid: process.pid, startedAt: Date.now(), updatedAt: 0,
    sourceBytes: 0, indexBytes: 0, sourceCalls: 0, indexCalls: 0,
    peakSourceBuffer: 0, peakIndexBuffer: 0, directoryReads: 0, blocked: [] }
  const persist = () => { stats.updatedAt = Date.now(); write(output, JSON.stringify(stats)) }
  const rejectWhole = (operation, value) => {
    const kind = classify(value)
    if (!kind) return
    if (stats.blocked.length < 8) stats.blocked.push({ operation, kind })
    persist()
    throw new Error(`Unmetered history operation: ${operation}`)
  }
  const record = (kind, bytes, allocation) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid actual history byte count')
    stats[`${kind}Bytes`] += bytes; stats[`${kind}Calls`]++
    const key = kind === 'source' ? 'peakSourceBuffer' : 'peakIndexBuffer'
    stats[key] = Math.max(stats[key], allocation)
    persist()
  }
  const open = promises.open.bind(promises)
  promises.open = async (...args) => {
    const file = await open(...args), kind = classify(args[0])
    if (!kind) return file
    const fd = file.fd, close = file.close.bind(file)
    descriptors.set(fd, { kind, handle: file }); handles.set(file, kind)
    file.close = async () => { try { return await close() } finally {
      if (descriptors.get(fd)?.handle === file) descriptors.delete(fd)
    } }
    for (const method of ['read', 'readv']) {
      const original = file[method].bind(file)
      file[method] = async (...values) => {
        const input = values[0]
        const allocation = method === 'readv' ? input.reduce((sum, value) => sum + value.byteLength, 0)
          : (ArrayBuffer.isView(input) ? input.byteLength : input?.buffer?.byteLength ?? 0)
        const result = await original(...values)
        record(kind, result.bytesRead, allocation)
        return result
      }
    }
    for (const method of ['readFile', 'createReadStream', 'readLines', 'readableWebStream']) {
      if (typeof file[method] === 'function') file[method] = () => rejectWhole(`FileHandle.${method}`, file)
    }
    return file
  }
  const directoryOpen = promises.opendir.bind(promises)
  promises.opendir = async (...args) => {
    const directory = await directoryOpen(...args), original = directory.read.bind(directory)
    directory.read = async (...values) => { const result = await original(...values); stats.directoryReads++; persist(); return result }
    return directory
  }
  for (const target of [fs, promises]) for (const method of ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync']) {
    if (typeof target[method] !== 'function') continue
    const original = target[method].bind(target)
    target[method] = (...args) => { rejectWhole(method, args[0]); if (method === 'createReadStream') rejectWhole(method, args[1]?.fd); return original(...args) }
  }
  // Current production history readers use FileHandle. Refuse other descriptor routes before source I/O.
  for (const method of ['open', 'openSync', 'read', 'readSync', 'readv', 'readvSync']) {
    const original = fs[method].bind(fs)
    fs[method] = (...args) => { rejectWhole(`fs.${method}`, args[0]); return original(...args) }
  }
  globalThis.__guguHistoryIoTrace = { snapshot: () => JSON.parse(JSON.stringify(stats)), output }
  syncBuiltinESMExports()
  persist()
}
