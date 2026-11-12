import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat'
import { phoneMarket } from '../../../../apps/desktop/src/components/appSlot/phoneMarket'
import { PHONE_ASSISTANT_RULES_KEPT_KEY, readPhoneAssistantRules, type PhoneMarketData } from '../../../../apps/desktop/src/components/appSlot/phoneAssistantRules'
import { currentMarketHost, GUGU_APPS_REPO, type MarketIndexVersion } from '../../../../apps/desktop/src/session/shared/extensions/market'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { SHIPPED_RELEASE_TRUST, type ReleaseTrustTable } from '../../../../apps/desktop/src/session/shared/extensions/release/release-trust'
import { RELEASE_LEGAL_FILES, signTestRelease, testKey, testTrust, type SignedTestRelease } from '../../../../apps/desktop/electron/session/main/core/extensions/test-support/signed-release'
import { NEUTRAL_ASSISTANT_RULES } from '../assistantRules/neutralRules'
import { markedRules } from '../assistantRules/fixtureApp'

vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
// The phone path runs the contract's web copy (release-trust-web.ts), whose signature check is release-crypto-web.ts:
// counted here to show it is that one that answers. Key making and signing below stay Node's.
const webCrypto = vi.hoisted(() => ({ verified: 0 }))
vi.mock('../../../../apps/desktop/src/session/shared/extensions/release/release-crypto-web', async (importOriginal) => {
  const web = await importOriginal<typeof import('../../../../apps/desktop/src/session/shared/extensions/release/release-crypto-web')>()
  return { ...web, verify: (...args: Parameters<typeof web.verify>) => { webCrypto.verified += 1; return web.verify(...args) } }
})

// #1931 The phone's route to the assistant's product rules: the market's assistant App, read (never installed) and believed
// on the desktop's terms — its signed release verified with the shipped keys before its package is fetched, the files it
// reads compared with the signed bytes, the kept copy checked again whenever it is read. Anything that fails leaves the
// last good copy as it was.
const APP = 'gugu-assistant'
const key = testKey()
const trust = testTrust(key, [APP])
const OFFICIAL = (version: string) => ({ repo: GUGU_APPS_REPO, path: `releases/${APP}/${version}`, commit: 'a'.repeat(40) })
let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'phone-assistant-rules-')) })
afterEach(() => rmSync(work, { recursive: true, force: true }))

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function appFiles(version: string, rules = NEUTRAL_ASSISTANT_RULES): Record<string, string> {
  const manifest = {
    id: APP, name: 'Assistant', version, apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    contributes: { assistantRules: 'rules' },
  }
  return {
    'manifest.json': JSON.stringify(manifest), 'index.html': '<!doctype html>', ...RELEASE_LEGAL_FILES,
    ...Object.fromEntries(Object.entries(assistantRulesFiles(rules)).map(([name, text]) => [`rules/${name}`, text])),
  }
}

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(files)) zip.file(name, text, { date: new Date(0) })
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))
}

/** Signs `files` (laid out as the maintainer's build sees them) as the release of the package `zip`. */
function sign(version: string, files: Record<string, string>, zip: Uint8Array, over: Partial<Parameters<typeof signTestRelease>[0]> = {}): SignedTestRelease {
  const dir = mkdtempSync(join(work, 'signed-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return signTestRelease({ appDir: dir, appId: APP, version, zip, key, ...over })
}

/** A download site with the App published at `version`; `change` edits what it serves (the index row, the files). */
async function site(options: {
  version?: string
  files?: Record<string, string>
  zip?: Uint8Array
  release?: SignedTestRelease | null
  change?: (row: MarketIndexVersion, served: Map<string, Uint8Array>) => void
} = {}) {
  const version = options.version ?? '1.0.0'
  const files = options.files ?? appFiles(version)
  const zip = options.zip ?? await zipOf(files)
  const release = options.release === undefined ? sign(version, files, zip) : options.release
  const at = `releases/${APP}/${version}-${sha256(zip).slice(0, 12)}`
  const row: MarketIndexVersion = {
    version, manifest: JSON.parse(files['manifest.json']!), apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: '',
    publishedAt: '2026-11-11T00:00:00Z', sha256: sha256(zip), bytes: zip.byteLength, bundle: `${at}/app.zip`, icon: null, source: OFFICIAL(version), yanked: null,
    ...(release ? { release: { keyId: release.release.keyId, manifest: `${at}/release.json`, signature: `${at}/release.sig` } } : {}),
  }
  const served = new Map<string, Uint8Array>([[row.bundle, zip]])
  if (release) { served.set(`${at}/release.json`, release.raw); served.set(`${at}/release.sig`, release.signature) }
  options.change?.(row, served)
  const reads: string[] = []
  const read = async (path: string, maxBytes?: number) => {
    reads.push(path)
    if (path === 'index.json') return new TextEncoder().encode(JSON.stringify({ apps: [{ id: APP, deprecated: null, versions: [row] }] }))
    const bytes = served.get(path)
    if (!bytes) throw new Error(`404 ${path}`)
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new Error(`${path}: more than ${maxBytes} bytes`)
    return bytes
  }
  return { row, read, reads, release }
}

/** The phone's `marketData` (phoneApps.ts) over a site: the phone market's fetch for data, the package unpacked, its manifest read. */
function marketDataOf(read: (path: string, maxBytes?: number) => Promise<Uint8Array>, table: ReleaseTrustTable = trust): PhoneMarketData {
  const market = phoneMarket(read, () => currentMarketHost('0.3.3', 'phone'), { read: async () => null, write: async () => undefined }, undefined, (path) => path, table)
  return async (id) => {
    const fetched = await market.fetchData(id)
    const zip = await JSZip.loadAsync(fetched.bytes)
    const files = new Map<string, Uint8Array>()
    for (const entry of Object.values(zip.files)) if (!entry.dir) files.set(entry.name, await entry.async('uint8array'))
    const manifest = parseExtensionManifest(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))))
    return { files, manifest, source: fetched.source, version: fetched.version, ...(fetched.release ? { release: fetched.release } : {}) }
  }
}

function storage() {
  const items = new Map<string, string>()
  return { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, value) }, items }
}
const offline: PhoneMarketData = async () => { throw new Error('offline') }

/** A phone that read the signed 1.0.0 once (its kept copy is good), and that kept copy as stored. */
async function phoneThatReadOnce() {
  const kept = storage()
  const good = await site()
  expect(await readPhoneAssistantRules({ marketData: marketDataOf(good.read), storage: kept, trust })).toEqual(NEUTRAL_ASSISTANT_RULES)
  return { kept, stored: kept.items.get(PHONE_ASSISTANT_RULES_KEPT_KEY)! }
}

/** What a phone that read once ends up with after a market read of `served`: the kept copy, never the new one, and the copy unchanged. */
async function refusedOverKept(served: Awaited<ReturnType<typeof site>>, table: ReleaseTrustTable = trust) {
  const { kept, stored } = await phoneThatReadOnce()
  expect(await readPhoneAssistantRules({ marketData: marketDataOf(served.read, table), storage: kept, trust })).toEqual(NEUTRAL_ASSISTANT_RULES)
  expect(kept.items.get(PHONE_ASSISTANT_RULES_KEPT_KEY)).toBe(stored)
  expect(await readPhoneAssistantRules({ marketData: marketDataOf(served.read, table), storage: storage(), trust })).toBeNull()
}

describe('the phone reads the assistant\'s rules from the market\'s signed assistant App', () => {
  it('takes the signed release\'s rules, checked by the page\'s Ed25519, and keeps them with their proof for offline', async () => {
    const before = webCrypto.verified
    const { kept, stored } = await phoneThatReadOnce()
    expect(webCrypto.verified).toBeGreaterThan(before)
    expect(JSON.parse(stored)).toMatchObject({ appVersion: '1.0.0', folder: 'rules', release: { keyId: key.id } })
    expect(Object.keys(JSON.parse(stored).files).sort()).toEqual(['manifest.json', ...Object.keys(assistantRulesFiles(NEUTRAL_ASSISTANT_RULES)).map((name) => `rules/${name}`)].sort())
    // Offline later: the kept copy, its release verified and its files compared again.
    expect(await readPhoneAssistantRules({ marketData: offline, storage: kept, trust })).toEqual(NEUTRAL_ASSISTANT_RULES)
    expect(kept.items.get(PHONE_ASSISTANT_RULES_KEPT_KEY)).toBe(stored)
  })

  it('downgrade: a version listed without its signed release is refused before anything is fetched', async () => {
    const unsigned = await site({ release: null })
    await refusedOverKept(unsigned)
    expect(unsigned.reads.filter((path) => path !== 'index.json')).toEqual([])
  })

  it('a swapped package (index row and zip replaced, release.json and .sig untouched) is refused before the zip is fetched', async () => {
    const forged = await zipOf(appFiles('1.0.0', markedRules('FORGED')))
    const swapped = await site({ change: (row, served) => { served.set(row.bundle, forged); row.sha256 = sha256(forged); row.bytes = forged.byteLength } })
    await refusedOverKept(swapped)
    expect(swapped.reads).not.toContain(swapped.row.bundle)
  })

  it('a changed release.json, a signature by another key, a release of another version or App: refused', async () => {
    const changed = await site({ change: (row, served) => {
      served.set(row.release!.manifest, new TextEncoder().encode(new TextDecoder().decode(served.get(row.release!.manifest)).replace('"rulesVersion": "1.0.0"', '"rulesVersion": "1.0.1"')))
    } })
    await refusedOverKept(changed)
    const files = appFiles('1.0.0')
    const zip = await zipOf(files)
    await refusedOverKept(await site({ files, zip, release: sign('1.0.0', files, zip, { key: testKey(key.id) }) }))
    await refusedOverKept(await site({ files, zip, release: sign('1.0.1', files, zip) }))
    await refusedOverKept(await site({ files, zip, release: sign('1.0.0', files, zip, { appId: 'other-app' }) }))
  })

  it('a revoked key is refused — the market\'s release and the kept copy signed with it alike', async () => {
    const revoked: ReleaseTrustTable = { schemaVersion: 1, keys: trust.keys.map((entry) => ({ ...entry, revoked: true })) }
    const { kept } = await phoneThatReadOnce()
    const good = await site()
    expect(await readPhoneAssistantRules({ marketData: marketDataOf(good.read, revoked), storage: kept, trust: revoked })).toBeNull()
    // The shipped table (its slot still empty) believes neither.
    expect(await readPhoneAssistantRules({ marketData: marketDataOf(good.read, SHIPPED_RELEASE_TRUST), storage: kept })).toBeNull()
    // The read believes only its own keys: a release the market check took with others is not taken.
    expect(await readPhoneAssistantRules({ marketData: marketDataOf(good.read, trust), storage: storage(), trust: revoked })).toBeNull()
  })

  it('a package the market check did not hold to a signed release (a table that does not name the App) gives no rules', async () => {
    const good = await site()
    const unnamed: ReleaseTrustTable = { schemaVersion: 1, keys: [] }
    expect(await readPhoneAssistantRules({ marketData: marketDataOf(good.read, unnamed), storage: storage(), trust })).toBeNull()
  })

  it('a package whose rules are not the signed bytes (one changed, added or missing) is refused, nothing of it kept', async () => {
    const signedFiles = appFiles('1.0.0')
    const [firstRule] = Object.keys(signedFiles).filter((name) => name.startsWith('rules/')).sort()
    for (const served of [
      { ...signedFiles, [firstRule!]: `${signedFiles[firstRule!]}changed\n` },
      { ...signedFiles, 'rules/extra.md': 'x\n' },
      Object.fromEntries(Object.entries(signedFiles).filter(([name]) => name !== firstRule)),
    ]) {
      // The signed release lists the files it was built from, its app.zip artifact is the package served: only the files differ.
      const zip = await zipOf(served)
      await refusedOverKept(await site({ files: served, zip, release: sign('1.0.0', signedFiles, zip) }))
    }
  })

  it('a kept copy edited in storage, without its proof, or for another version is not used', async () => {
    const edits: Array<(kept: { appVersion: string; folder: string; release: unknown; files: Record<string, string> }) => void> = [
      (kept) => { const [name] = Object.keys(kept.files).filter((path) => path.startsWith('rules/')); kept.files[name!] = btoa('changed\n') },
      (kept) => { kept.files['rules/extra.md'] = btoa('x\n') },
      // Valid rules, but not the signed bytes.
      (kept) => { for (const [name, text] of Object.entries(assistantRulesFiles(markedRules('EDITED')))) kept.files[`rules/${name}`] = Buffer.from(text).toString('base64') },
      (kept) => { delete kept.files['manifest.json'] },
      (kept) => { kept.folder = 'other' },
      (kept) => { delete (kept as { release?: unknown }).release },
      (kept) => { kept.appVersion = '1.0.1' },
    ]
    for (const edit of edits) {
      const { kept, stored } = await phoneThatReadOnce()
      const copy = JSON.parse(stored)
      edit(copy)
      kept.setItem(PHONE_ASSISTANT_RULES_KEPT_KEY, JSON.stringify(copy))
      expect(await readPhoneAssistantRules({ marketData: offline, storage: kept, trust })).toBeNull()
    }
    // Another signed folder of the same release, swapped in as the one read: the signed manifest names `rules`, not it.
    const files = { ...appFiles('1.0.0'), ...Object.fromEntries(Object.entries(assistantRulesFiles(markedRules('OLD'))).map(([name, text]) => [`old/${name}`, text])) }
    const kept = storage()
    expect(await readPhoneAssistantRules({ marketData: marketDataOf((await site({ files })).read), storage: kept, trust })).toEqual(NEUTRAL_ASSISTANT_RULES)
    const copy = JSON.parse(kept.items.get(PHONE_ASSISTANT_RULES_KEPT_KEY)!)
    copy.folder = 'old'
    copy.files = { 'manifest.json': copy.files['manifest.json'], ...Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('old/')).map(([name, text]) => [name, Buffer.from(text).toString('base64')])) }
    kept.setItem(PHONE_ASSISTANT_RULES_KEPT_KEY, JSON.stringify(copy))
    expect(await readPhoneAssistantRules({ marketData: offline, storage: kept, trust })).toBeNull()
    // A copy kept before releases were checked (the rules alone) is not used either.
    const old = storage()
    old.setItem(PHONE_ASSISTANT_RULES_KEPT_KEY, JSON.stringify({ appVersion: '1.0.0', files: assistantRulesFiles(NEUTRAL_ASSISTANT_RULES) }))
    expect(await readPhoneAssistantRules({ marketData: offline, storage: old, trust })).toBeNull()
  })

  it('never takes rules from an App outside gugu\'s market repository or its release folder', async () => {
    await refusedOverKept(await site({ change: (row) => { row.source = { ...row.source, repo: 'someone/gugu-apps' } } }))
    await refusedOverKept(await site({ change: (row) => { row.source = { ...row.source, path: 'sources/gugu-assistant' } } }))
  })

  it('refuses a signed rules folder that is not exactly the format, as the desktop does', async () => {
    const files = { ...appFiles('1.0.0'), 'rules/recovery.md': 'a\r\nb\n' }
    await refusedOverKept(await site({ files }))
  })

  it('has none when it never read them and cannot now', async () => {
    expect(await readPhoneAssistantRules({ marketData: offline, storage: storage(), trust })).toBeNull()
  })
})

