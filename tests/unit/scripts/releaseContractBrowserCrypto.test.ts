import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { RELEASE_CONTRACT_FILE, RELEASE_CRYPTO_WEB_FILE, releaseContractBrowserCrypto, releaseContractCryptoFor } from '../../../scripts/build/release-contract-browser-crypto.mts'

// #1931 In the page bundle the release contract's `node:crypto` — and nothing else's — is the Ed25519-only web stand-in.
describe('release contract crypto in the page bundle', () => {
  test('the contract\'s node:crypto (with or without a query) is the web stand-in', () => {
    expect(releaseContractCryptoFor('node:crypto', RELEASE_CONTRACT_FILE)).toBe(RELEASE_CRYPTO_WEB_FILE)
    expect(releaseContractCryptoFor('crypto', `${RELEASE_CONTRACT_FILE}?v=1`)).toBe(RELEASE_CRYPTO_WEB_FILE)
    expect(readFileSync(RELEASE_CONTRACT_FILE, 'utf8')).toContain("from 'node:crypto'")
  })

  test('every other import keeps Vite\'s resolution', () => {
    expect(releaseContractCryptoFor('node:crypto', RELEASE_CRYPTO_WEB_FILE)).toBeNull()
    expect(releaseContractCryptoFor('node:crypto', undefined)).toBeNull()
    expect(releaseContractCryptoFor('node:fs', RELEASE_CONTRACT_FILE)).toBeNull()
    expect(releaseContractBrowserCrypto()).toMatchObject({ name: 'gugu-release-contract-browser-crypto', enforce: 'pre' })
  })

  test('the renderer build uses it', () => {
    const config = readFileSync(new URL('../../../vite.config.mts', import.meta.url), 'utf8')
    expect(config).toMatch(/plugins: \[\n(?:\s*\/\/.*\n)*\s*releaseContractBrowserCrypto\(\),\n\s*startupFirstFrame\(isElectronTarget\)/)
  })
})
