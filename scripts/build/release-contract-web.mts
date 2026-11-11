// #1931 The page's copy of the market's release contract. release-contract.mjs is gugu-apps' file byte for byte (pinned in
// release-contract.pin.json) and imports `node:crypto`, which the page (the desktop renderer, the phone) does not have: in
// the desktop renderer that import becomes a shim that calls `require`, and the window never starts. So the page never
// imports it. It imports release-contract-web.mjs, the same file with only its crypto import changed, to
// release-crypto-web.ts. Nothing else may differ: the drift test compares the committed copy with `webContractFrom`.
// After moving the pin, refresh it with: node scripts/build/release-contract-web.mts --write
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const releaseDir = new URL('../../apps/desktop/src/session/shared/extensions/release/', import.meta.url)
export const RELEASE_CONTRACT_FILE = fileURLToPath(new URL('release-contract.mjs', releaseDir))
export const RELEASE_CONTRACT_WEB_FILE = fileURLToPath(new URL('release-contract-web.mjs', releaseDir))

export const NODE_CRYPTO_IMPORT = "import { createHash, createPublicKey, verify } from 'node:crypto';"
export const WEB_CRYPTO_IMPORT =
  "import { createHash, createPublicKey, verify } from './release-crypto-web.ts'; // generated from release-contract.mjs by scripts/build/release-contract-web.mts; only this line differs"

/**
 * The page's contract from the mirrored one: its one `node:crypto` import pointed at release-crypto-web.ts. Refuses a
 * contract that imports anything else (a new import needs a decision on how the page gets it, not a silent copy).
 */
export function webContractFrom(source: string): string {
  const lines = source.split('\n')
  const imports = lines.flatMap((line, at) => (/^\s*(import|export)\b.*\bfrom\s*['"]|\brequire\s*\(|\bimport\s*\(/.test(line) ? [at] : []))
  if (imports.length !== 1 || lines[imports[0]!] !== NODE_CRYPTO_IMPORT) {
    throw new Error(`release-contract.mjs must import exactly \`${NODE_CRYPTO_IMPORT}\` and nothing else; found ${imports.map((at) => `line ${at + 1}`).join(', ') || 'no import'}`)
  }
  lines[imports[0]!] = WEB_CRYPTO_IMPORT
  return lines.join('\n')
}

if (process.argv[1]?.endsWith('release-contract-web.mts')) {
  const expected = webContractFrom(readFileSync(RELEASE_CONTRACT_FILE, 'utf8'))
  if (process.argv.includes('--write')) writeFileSync(RELEASE_CONTRACT_WEB_FILE, expected)
  else if (readFileSync(RELEASE_CONTRACT_WEB_FILE, 'utf8') !== expected) {
    console.error('release-contract-web.mjs is not release-contract.mjs with its crypto import changed; run: node scripts/build/release-contract-web.mts --write')
    process.exitCode = 1
  }
}
