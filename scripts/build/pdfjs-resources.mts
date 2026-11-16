import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Every directory pdf.js fetches at runtime by a base URL passed to `getDocument`, keyed by that
 * option: predefined CMaps (`cMapUrl`, CID fonts without ToUnicode), the standard 14 font
 * substitutes (`standardFontDataUrl`, non-embedded fonts), the decoders (`wasmUrl`: OpenJPEG for
 * JPX images, JBIG2, QCMS for ICC colour) and the CMYK profile (`iccUrl`). Licenses ship alongside.
 */
export const PDFJS_RESOURCE_DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm'
}

/** Emits the installed pdf.js resources under `pdfjs/<directory>/` with their original names. */
export function pdfjsResources(): Plugin {
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
  const root = dirname(require.resolve('pdfjs-dist/package.json'))
  const files = new Map<string, Buffer>(
    PDFJS_RESOURCE_DIRECTORIES.flatMap((directory) =>
      readdirSync(join(root, directory))
        .sort()
        .map((name) => [`${directory}/${name}`, readFileSync(join(root, directory, name))] as const)
    )
  )
  let prefix = '/pdfjs/'

  return {
    name: 'gugu-pdfjs-resources',
    configResolved(config) {
      prefix = new URL(`${config.base}pdfjs/`, 'http://vite.invalid/').pathname
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://vite.invalid/').pathname
        if (!pathname.startsWith(prefix)) return next()
        const name = pathname.slice(prefix.length)
        const bytes = files.get(name)
        if (!bytes) {
          response.statusCode = 404
          response.end('Unknown pdf.js resource')
          return
        }
        response.setHeader('Content-Type', CONTENT_TYPES[extname(name)] ?? 'application/octet-stream')
        response.setHeader('Cache-Control', 'no-cache')
        response.end(request.method === 'HEAD' ? undefined : bytes)
      })
    },
    generateBundle() {
      for (const [name, source] of files) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${name}`, source })
      }
    }
  }
}
