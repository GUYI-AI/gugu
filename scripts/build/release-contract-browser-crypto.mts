// #1931 The market's release contract (apps/desktop/src/session/shared/extensions/release/release-contract.mjs, gugu-apps'
// file mirrored byte for byte) imports `node:crypto`. In the page bundle — the phone runs it in its WebView — that import,
// and only that one, is served by release-crypto-web.ts (Ed25519 in pure JS), so the phone checks a release with the very
// same contract code as main, unedited. Everything else keeps Vite's own resolution.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const RELEASE_CONTRACT_FILE = path.join(root, 'apps/desktop/src/session/shared/extensions/release/release-contract.mjs')
export const RELEASE_CRYPTO_WEB_FILE = path.join(root, 'apps/desktop/src/session/shared/extensions/release/release-crypto-web.ts')

/** Where `id` imported by `importer` resolves for the page bundle: the web crypto for the contract's `node:crypto`, else null (Vite decides). */
export function releaseContractCryptoFor(id: string, importer: string | undefined): string | null {
  if (id !== 'node:crypto' && id !== 'crypto') return null
  if (!importer) return null
  return path.resolve(importer.split('?')[0]!) === RELEASE_CONTRACT_FILE ? RELEASE_CRYPTO_WEB_FILE : null
}

export function releaseContractBrowserCrypto(): { name: string; enforce: 'pre'; resolveId(id: string, importer?: string): string | null } {
  return {
    name: 'gugu-release-contract-browser-crypto',
    enforce: 'pre',
    resolveId: (id, importer) => releaseContractCryptoFor(id, importer),
  }
}
