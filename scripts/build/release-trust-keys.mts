// #1931 A release build ships the client's trust table for compiled market releases
// (apps/desktop/src/session/shared/extensions/release/release-keys.json). An App it names installs only as a release
// signed with one of its keys, so a slot left empty (`publicKey: null`) means that App never installs and the assistant has
// no trusted rules. This gate stops a production build in that state: build-env-preflight.mts runs it whenever the build
// targets the production database, and `pnpm release:trust-keys` runs it on its own.
import { createPublicKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_TRUST_TABLE = 'apps/desktop/src/session/shared/extensions/release/release-keys.json'
/** Apps a release must be able to install whatever the table says: the assistant's rules come from this one. */
export const RELEASE_REQUIRED_APPS: readonly string[] = Object.freeze(['gugu-assistant'])

interface Entry { id?: unknown; appId?: unknown; sourceRepo?: unknown; publicKey?: unknown; revoked?: unknown }

/** Why a release may not ship with this table: per App it names (and per required App), no usable Ed25519 key. */
export function releaseTrustKeyProblems(table: unknown, required: readonly string[] = RELEASE_REQUIRED_APPS): string[] {
  const keys = (table as { schemaVersion?: unknown; keys?: unknown } | null)
  if (!keys || keys.schemaVersion !== 1 || !Array.isArray(keys.keys)) return ['the release trust table is not { schemaVersion: 1, keys: [...] }']
  const entries = keys.keys as Entry[]
  const apps = [...new Set([...required, ...entries.map((entry) => String(entry.appId))])].sort()
  const problems: string[] = []
  for (const app of apps) {
    const own = entries.filter((entry) => entry.appId === app)
    if (!own.length) { problems.push(`${app}: the table has no entry for it`); continue }
    const usable = own.filter((entry) => {
      if (typeof entry.publicKey !== 'string' || entry.revoked === true) return false
      try { return createPublicKey(entry.publicKey).asymmetricKeyType === 'ed25519' } catch { return false }
    })
    if (!usable.length) {
      const slots = own.filter((entry) => entry.publicKey === null).map((entry) => String(entry.id))
      problems.push(slots.length
        ? `${app}: key slot ${slots.join(', ')} is still empty — put its Ed25519 public key (SPKI PEM) in before a release`
        : `${app}: none of its keys is a usable, unrevoked Ed25519 public key`)
    }
  }
  return problems
}

/** The gate as a build runs it from the repository root: the table read from `rootDir`, problems prefixed for the build log. */
export function releaseTrustGate(rootDir: string): string[] {
  const file = path.join(rootDir, RELEASE_TRUST_TABLE)
  if (!existsSync(file)) return [`release trust table ${RELEASE_TRUST_TABLE} is missing`]
  let table: unknown
  try { table = JSON.parse(readFileSync(file, 'utf8')) } catch { return [`release trust table ${RELEASE_TRUST_TABLE} is not JSON`] }
  return releaseTrustKeyProblems(table).map((problem) => `release trust table ${RELEASE_TRUST_TABLE}: ${problem}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = releaseTrustGate(process.cwd())
  for (const problem of problems) console.error(`✗ ${problem}`)
  if (problems.length) process.exit(1)
  console.log('release trust table: every App it names has a usable key')
}
