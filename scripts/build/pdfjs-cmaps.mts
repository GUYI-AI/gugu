import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

/** PDF.js fetches predefined CMaps by their original names, including for embedded CFF CID fonts. */
export function pdfjsCMaps(): Plugin {
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
  const directory = join(dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps')
  const files = new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith('.bcmap') || name === 'LICENSE')
      .sort()
      .map((name) => [name, readFileSync(join(directory, name))])
  )
  let prefix = '/pdfjs/cmaps/'

  return {
    name: 'gugu-pdfjs-cmaps',
    configResolved(config) {
      prefix = new URL(`${config.base}pdfjs/cmaps/`, 'http://vite.invalid/').pathname
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://vite.invalid/').pathname
        if (!pathname.startsWith(prefix)) return next()
        const bytes = files.get(pathname.slice(prefix.length))
        if (!bytes) {
          response.statusCode = 404
          response.end('Unknown PDF CMap')
          return
        }
        response.setHeader('Content-Type', 'application/octet-stream')
        response.setHeader('Cache-Control', 'no-cache')
        response.end(request.method === 'HEAD' ? undefined : bytes)
      })
    },
    generateBundle() {
      for (const [name, source] of files) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/cmaps/${name}`, source })
      }
    }
  }
}
