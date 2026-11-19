import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { obtainMiseArchive } from '../../../scripts/build/mise-archive-cache.mts'

// curl is synchronous, so the HTTP fixture must run in a separate process.
it('real curl distinguishes HTTP 503 retries/mirror from HTTP 404 and verified-byte failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-3203-http-'))
  const trace = join(root, 'requests.json')
  const content = 'pinned archive served over actual HTTP'
  const sha256 = createHash('sha256').update(content).digest('hex')
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    const calls = [];
    const server = createServer((req, res) => {
      calls.push(req.url); writeFileSync(process.argv[1], JSON.stringify(calls));
      if (req.url.startsWith('/retry-primary/') ||
          (req.url.startsWith('/retry-mirror/') && calls.filter(x => x === req.url).length === 1)) {
        res.writeHead(503); res.end('temporary outage');
      } else if (req.url.startsWith('/missing/')) {
        res.writeHead(404); res.end('not found');
      } else if (req.url.startsWith('/wrong/')) {
        res.end('wrong archive');
      } else { res.end(process.argv[2]); }
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `, trace, content], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(server, 'exit')
  vi.stubEnv('NO_PROXY', '127.0.0.1')
  vi.stubEnv('no_proxy', '127.0.0.1')
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP fixture did not start')), 5000)
      server.once('error', error => { clearTimeout(timer); reject(error) })
      server.stdout.once('data', data => { clearTimeout(timer); resolve(Number(String(data).trim())) })
    })
    expect(port).toBeGreaterThan(0)
    const base = `http://127.0.0.1:${port}`
    const waits: number[] = []
    const common = { version: '1.0.0', asset: 'archive.zip', sha256, wait: (ms: number) => waits.push(ms), log: () => {}, warn: () => {} }
    const file = obtainMiseArchive({ ...common, cacheDir: join(root, 'retry'), downloadBase: base + '/retry-primary', mirrorBase: base + '/retry-mirror' })
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(JSON.parse(readFileSync(trace, 'utf8'))).toEqual([
      '/retry-primary/v1.0.0/archive.zip', '/retry-primary/v1.0.0/archive.zip',
      '/retry-mirror/v1.0.0/archive.zip', '/retry-mirror/v1.0.0/archive.zip',
    ])
    expect(waits).toEqual([1000, 1000, 1000])
    expect(readdirSync(join(root, 'retry', sha256))).toEqual(['archive.zip'])

    expect(() => obtainMiseArchive({ ...common, cacheDir: join(root, '404'), downloadBase: base + '/missing', mirrorBase: base + '/unused' })).toThrow('curl exit 22, HTTP 404')
    expect(() => obtainMiseArchive({ ...common, cacheDir: join(root, 'wrong'), downloadBase: base + '/wrong', mirrorBase: base + '/unused' })).toThrow('SHA-256 mismatch')
    const requests: string[] = JSON.parse(readFileSync(trace, 'utf8'))
    expect(requests.slice(4)).toEqual(['/missing/v1.0.0/archive.zip', '/wrong/v1.0.0/archive.zip'])
    expect(readdirSync(join(root, '404', sha256))).toEqual([])
    expect(readdirSync(join(root, 'wrong', sha256))).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    server.kill()
    await exited
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
