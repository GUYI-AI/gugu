// #1931 The copy of the assistant App's product rules a release carries, so a person who upgrades offline still has
// rules before the App can be fetched (electron/assistant-rules-root.ts starts the last good copy from it). This
// repository holds none of the words: at build time the App's package is fetched from the market at the version and
// sha256 pinned in scripts/assistant-rules-seed.json, its rules folder validated by the same validator the desktop and
// the phone use, and written to assistant-rules-seed/ (seed.json + rules/). The desktop package carries it through
// electron-builder's extraResources, the server package through build-gugu-server.mjs.
//
// No version pinned (the App not published yet): nothing is written and the release carries no copy. A pin that cannot
// be fetched, or whose bytes or rules do not check out, fails the build loudly — never another source.
//
// `--market=<base URL>` reads another download site (tests); `--out=<dir>` writes elsewhere.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { assistantRulesFromPackage } from '../../apps/desktop/src/session/shared/extensions/assistant-rules-parse'

const root = resolve(__dirname, '..', '..')
const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const pinPath = resolve(argument('pin') ?? join(root, 'scripts', 'assistant-rules-seed.json'))
const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as { app: string; version: string | null; bundle: string | null; sha256: string | null }
const out = resolve(argument('out') ?? join(root, 'assistant-rules-seed'))
const market = argument('market') ?? (JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'electron', 'updateFeeds.json'), 'utf8')) as { market: string }).market

async function main(): Promise<void> {
  // A copy from an earlier pin is never carried by a build of another one.
  rmSync(out, { recursive: true, force: true })
  if (!pin.version) {
    console.log(`[assistant-rules-seed] no ${pin.app} version pinned in ${pinPath}: this build carries no copy of its rules`)
    return
  }
  if (!pin.bundle || !/^[0-9a-f]{64}$/.test(pin.sha256 ?? '')) throw new Error(`${pinPath}: a pinned version needs its bundle path and sha256`)

  const url = new URL(pin.bundle, market.endsWith('/') ? market : `${market}/`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${pin.app}@${pin.version}: ${url.href} answered ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== pin.sha256) throw new Error(`${pin.app}@${pin.version}: the bundle's sha256 is ${sha256}, the pin says ${pin.sha256}`)

  const zip = await JSZip.loadAsync(bytes)
  const files = new Map<string, Uint8Array>()
  for (const entry of Object.values(zip.files)) if (!entry.dir) files.set(entry.name, await entry.async('uint8array'))
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) throw new Error(`${pin.app}@${pin.version}: the bundle has no manifest.json`)
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { id?: string; version?: string; contributes?: { assistantRules?: string } }
  if (manifest.id !== pin.app || manifest.version !== pin.version) throw new Error(`the bundle holds ${manifest.id}@${manifest.version}, not ${pin.app}@${pin.version}`)
  const folder = manifest.contributes?.assistantRules
  if (!folder) throw new Error(`${pin.app}@${pin.version} declares no assistant rules`)
  // The same validator as every reader; what is written is the App's own bytes.
  const rules = assistantRulesFromPackage(files, folder)

  mkdirSync(join(out, 'rules'), { recursive: true })
  const prefix = `${folder.replace(/\/+$/, '')}/`
  for (const [path, content] of files) if (path.startsWith(prefix)) writeFileSync(join(out, 'rules', path.slice(prefix.length)), content)
  writeFileSync(join(out, 'seed.json'), `${JSON.stringify({ app: pin.app, version: pin.version, sha256 }, null, 2)}\n`)
  console.log(`[assistant-rules-seed] ${pin.app}@${pin.version} rules ${rules.rulesVersion} → ${out}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
