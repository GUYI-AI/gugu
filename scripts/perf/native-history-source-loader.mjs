import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, join, relative, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
if (!process.env.GUGU_HISTORY_SOURCE_ROOT) throw new Error('Explicit pinned source root required')
const root = realpathSync(process.env.GUGU_HISTORY_SOURCE_ROOT)
const pin = JSON.parse(readFileSync(join(root, 'PIN.json'), 'utf8'))
if (pin.sha !== process.env.GUGU_HISTORY_SOURCE_SHA) throw new Error('Source SHA mismatch')
registerHooks({ resolve(specifier, context, next) {
  let target
  if (specifier.startsWith('@gugu/session-core/')) target = join(root, 'packages/session-core/src', specifier.slice('@gugu/session-core/'.length))
  else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) target = fileURLToPath(new URL(specifier, context.parentURL))
  else if (specifier.startsWith('file:')) target = fileURLToPath(specifier)
  else if (specifier.startsWith('/')) target = resolve(specifier)
  if (target) for (const candidate of [target, ...['.ts', '.mts', '.mjs', '.js', '/index.ts'].map(suffix => target + suffix)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const physical = realpathSync(candidate)
      if (physical.startsWith(root + sep)) {
        const key = relative(root, physical).split(sep).join('/')
        if (createHash('sha256').update(readFileSync(candidate)).digest('hex') !== pin.files[key]) throw new Error(`Unpinned source: ${key}`)
      }
      return next(pathToFileURL(candidate).href, context)
    }
  }
  return next(specifier, context)
} })
