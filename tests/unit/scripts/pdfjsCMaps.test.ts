import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { build, createServer, loadConfigFromFile } from 'vite'
import { pdfjsCMaps } from '../../../scripts/build/pdfjs-cmaps.mts'

const roots: string[] = []
const source = resolve('apps/desktop/node_modules/pdfjs-dist/cmaps')
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gugu-pdf-cmaps-'))
  roots.push(root)
  writeFileSync(join(root, 'entry.js'), 'export const value = 1\n')
  return root
}

it('enables CMaps in the real renderer build configuration', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'test' },
    resolve('vite.config.mts')
  )
  expect(
    loaded?.config.plugins?.some(
      (plugin) =>
        plugin &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'gugu-pdfjs-cmaps'
    )
  ).toBe(true)
})

it.each(['./', '/nested/'])(
  'packages every installed CMap and its license with original names (base %s)',
  async (base) => {
    const root = fixture()
    const built = await build({
      configFile: false,
      root,
      base,
      logLevel: 'silent',
      plugins: [pdfjsCMaps()],
      build: {
        write: false,
        minify: false,
        lib: { entry: join(root, 'entry.js'), formats: ['es'] }
      }
    })
    const result = Array.isArray(built) ? built[0] : built
    if (!('output' in result)) throw new Error('Expected a completed renderer build')
    const emitted = new Map(
      result.output
        .filter((asset) => asset.type === 'asset')
        .map((asset) => [asset.fileName, asset.source])
    )
    const names = readdirSync(source).filter(
      (name) => name.endsWith('.bcmap') || name === 'LICENSE'
    )
    expect(emitted.size).toBe(names.length)
    for (const name of names) {
      expect(Buffer.from(emitted.get(`pdfjs/cmaps/${name}`)!)).toEqual(
        readFileSync(join(source, name))
      )
    }
  }
)

it.each(['/', '/nested/'])(
  'serves binary CMaps from the configured development base %s',
  async (base) => {
    const server = await createServer({
      configFile: false,
      root: fixture(),
      base,
      appType: 'custom',
      logLevel: 'silent',
      plugins: [pdfjsCMaps()],
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { noDiscovery: true, include: [] }
    })
    try {
      await server.listen()
      const address = server.httpServer!.address()
      if (!address || typeof address === 'string') throw new Error('Expected a loopback server')
      const prefix = `http://127.0.0.1:${address.port}${base}pdfjs/cmaps/`
      const request = (name: string) =>
        fetch(`${prefix}${name}`, { headers: { connection: 'close' } })
      const response = await request('Adobe-GB1-UCS2.bcmap')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        readFileSync(join(source, 'Adobe-GB1-UCS2.bcmap'))
      )
      expect((await request('unknown.bcmap')).status).toBe(404)
      expect((await request('..%2Fpackage.json')).status).toBe(404)
    } finally {
      await server.close()
    }
  }
)
