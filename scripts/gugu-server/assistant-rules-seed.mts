// #1931 Which copy of the assistant App's rules a server package carries (build-gugu-server.mjs).
//
// The copy is the one the main build fetched and validated: `pnpm build:assistant-rules`
// (scripts/build/assistant-rules-seed.ts) writes it to <root>/assistant-rules-seed, beside dist-electron. Packaging only
// carries it, like the compiled output, and never fetches it again: an architecture's packaging job gets the scripts and the
// built output, not the source tree or its node_modules (scripts/gugu-server/ci-linux-packages.sh sends this folder along).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type SeedPin = { app: string; version: string | null; sha256: string | null }
type Seed = { app?: unknown; version?: unknown; sha256?: unknown }

/**
 * Nothing pinned in scripts/assistant-rules-seed.json: null, no copy (a leftover folder of an earlier pin is not carried).
 * Pinned: the folder of that copy. A pinned version without its copy, or a copy of another pin, is an error: a package
 * never silently ships without the rules it was pinned to, nor with another version's.
 */
export function assistantRulesSeedToCarry(root: string): string | null {
  const pinPath = join(root, 'scripts', 'assistant-rules-seed.json')
  const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as SeedPin
  if (!pin.version) return null
  const dir = join(root, 'assistant-rules-seed')
  const file = join(dir, 'seed.json')
  if (!existsSync(file)) {
    throw new Error(`${pinPath} pins ${pin.app}@${pin.version}, but ${dir} holds no copy of its rules: run the main build's pnpm build:assistant-rules first`)
  }
  const seed = JSON.parse(readFileSync(file, 'utf8')) as Seed
  if (seed.app !== pin.app || seed.version !== pin.version || seed.sha256 !== pin.sha256) {
    throw new Error(`${dir} holds ${String(seed.app)}@${String(seed.version)}, not the pinned ${pin.app}@${pin.version} (${pin.sha256})`)
  }
  return dir
}
