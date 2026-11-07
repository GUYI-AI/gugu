import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('meters source/readv and a cache created after preload behind a symlink; refuses whole reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-history-meter-'))
  try {
    const actual = join(root, 'actual'), alias = join(root, 'alias'), traces = join(root, 'traces')
    await mkdir(actual)
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(actual, 'source'), '0123456789')
    const output = execFileSync(process.execPath, ['--require', resolve('scripts/perf/native-history-io-preload.cjs'), '-e', `
      const fs = require('node:fs'), f = require('node:fs/promises'), assert = require('node:assert/strict');
      (async () => {
        const [source, cache] = process.argv.slice(1);
        await f.mkdir(require('node:path').dirname(cache)); await f.writeFile(cache, '0123456789');
        const s = await f.open(source, 'r'), c = await f.open(cache, 'r');
        await s.read(Buffer.alloc(16), 0, 4, 2); await c.readv([Buffer.alloc(2), Buffer.alloc(3)], 1);
        assert.throws(() => fs.readFileSync(source), /Unmetered history operation/);
        await assert.rejects(async () => f.readFile(cache), /Unmetered history operation/);
        assert.throws(() => s.readFile(), /Unmetered history operation/);
        assert.throws(() => fs.readFileSync(s.fd), /Unmetered history operation/);
        await assert.rejects(async () => f.readFile(s), /Unmetered history operation/);
        await s.close(); await c.close();
        console.log(JSON.stringify(globalThis.__guguHistoryIoTrace.snapshot()));
      })().catch(error => { console.error(error); process.exitCode = 1 });
    `, join(actual, 'source'), join(actual, 'cache', 'index')], {
      encoding: 'utf8', env: { ...process.env, GUGU_HISTORY_IO_TRACE: JSON.stringify({
        sources: [join(alias, 'source')], caches: [join(alias, 'cache')], outputDirectory: traces,
      }) },
    })
    const counters = JSON.parse(output)
    expect(counters).toMatchObject({ sourceBytes: 4, indexBytes: 5, sourceCalls: 1, indexCalls: 1,
      peakSourceBuffer: 16, peakIndexBuffer: 5 })
    expect(counters.blocked.map((value: { operation: string }) => value.operation))
      .toEqual(['readFileSync', 'readFile', 'FileHandle.readFile', 'readFileSync', 'readFile'])
    expect(JSON.parse(await readFile(join(traces, `history-io-${counters.pid}.json`), 'utf8')))
      .toMatchObject(counters)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses a source modified after its pinned manifest was created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-history-pin-'))
  try {
    const file = join(root, 'fixture.mjs'), text = 'export const value = 1\n', sha = '1'.repeat(40)
    await writeFile(file, text)
    await writeFile(join(root, 'PIN.json'), JSON.stringify({ sha, files: {
      'fixture.mjs': createHash('sha256').update(text).digest('hex'),
    } }))
    const args = ['--import', resolve('scripts/perf/native-history-source-loader.mjs'),
      '--input-type=module', '-e', 'await import(process.argv[1])', file]
    const options = { encoding: 'utf8' as const, stdio: 'pipe' as const, env: { ...process.env,
      GUGU_HISTORY_SOURCE_ROOT: root, GUGU_HISTORY_SOURCE_SHA: sha } }
    expect(execFileSync(process.execPath, args, options)).toBe('')
    await writeFile(file, text + 'export const changed = true\n')
    expect(() => execFileSync(process.execPath, args, options)).toThrow(/Unpinned source/)
    const outside = join(root, '..', `outside-${root.split('/').at(-1)}.mjs`)
    try {
      await writeFile(outside, text + 'export const escaped = true\n')
      await rm(file); await symlink(outside, file)
      expect(() => execFileSync(process.execPath, args, options)).toThrow(/escapes pinned root/)
    } finally { await rm(outside, { force: true }) }
  } finally { await rm(root, { recursive: true, force: true }) }
})
