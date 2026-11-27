/**
 * gugu-dev#1616 One account's local data per process, the layout headless server already uses (server-layout.ts
 * applyAccountEnv): a desktop process serves exactly one Gugu account, and that account's sessions, transcripts, files,
 * roster, agent homes, custom models and keys live in its own Electron userData and GUGU_HOME. Signing in as another
 * account relaunches into that account's directories.
 *
 * Before this, local data belonged to the machine (session-agent-bindings.ts: "agent identity belongs to the account,
 * tasks belong to the machine"), so the next account to sign in saw the previous one's sessions, transcripts and files,
 * and #4277 re-bound them to the new account's agents.
 *
 * Layout. The first account on a machine keeps the original directories, so an upgrade moves nothing and a downgrade
 * still finds its data. Every later account gets sibling directories (never inside another account's, so no process can
 * reach another account's data by walking its own):
 *   <machine userData>                         first account; also holds this registry and machine-wide state
 *   <machine userData>-accounts/<userId>/      every other account's userData
 *   GUGU_HOME:   <machine home> | <machine home>-accounts/<userId>   (or <account userData>/gugu-home when the home is
 *                                                                      derived from userData, as for --user-data-dir)
 *
 * This is product-level isolation (window, runtime, stores). Processes of one operating-system user can still read each
 * other's files; an agent with full access is that user.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ACCOUNT_REGISTRY_FILE = 'account-profiles.json'
export const ACCOUNT_HANDOFF_FILE = 'account-handoff.json'
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Machine-level: which account owns the original directories, and which account the next launch serves. */
export type AccountRegistry = { version: 1; rootOwner: string | null; current: string | null }

export type AccountLayout = { userId: string | null; userData: string; home: string; root: boolean }

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value)
}

export function readAccountRegistry(machineUserData: string): AccountRegistry {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(machineUserData, ACCOUNT_REGISTRY_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rootOwner: null, current: null }
    throw error
  }
  const value = JSON.parse(raw) as Partial<AccountRegistry>
  const id = (field: unknown) => field === null || isAccountId(field)
  // A registry that cannot be read must not fall back to "nobody owns this": that is how two accounts would share one.
  if (value.version !== 1 || !id(value.rootOwner) || !id(value.current)) throw new Error('Invalid account registry')
  return { version: 1, rootOwner: value.rootOwner ?? null, current: value.current ?? null }
}

export function writeAccountRegistry(machineUserData: string, registry: AccountRegistry): void {
  writePrivateJson(path.join(machineUserData, ACCOUNT_REGISTRY_FILE), registry)
}

/**
 * The first launch after the upgrade gives the original directories to the account that was signed in before it (the
 * desktop's own auth mirror). Nobody signed in: the first account to sign in claims them (decideAccountEntry).
 */
export function adoptLegacyOwner(registry: AccountRegistry, legacyMirrorUserId: string | null): AccountRegistry {
  if (registry.rootOwner !== null || !isAccountId(legacyMirrorUserId)) return registry
  return { version: 1, rootOwner: legacyMirrorUserId, current: registry.current ?? legacyMirrorUserId }
}

export function accountLayout(input: {
  machineUserData: string
  machineHome: string
  /** GUGU_HOME is <userData>/gugu-home (an explicit --user-data-dir): an account's home follows its own userData. */
  homeFollowsUserData: boolean
  registry: AccountRegistry
  userId: string | null
}): AccountLayout {
  const { machineUserData, machineHome, homeFollowsUserData, registry, userId } = input
  if (userId === null || userId === registry.rootOwner) {
    return { userId, userData: machineUserData, home: machineHome, root: true }
  }
  if (!isAccountId(userId)) throw new Error('Invalid account id')
  const userData = path.join(`${machineUserData}-accounts`, userId)
  return {
    userId,
    userData,
    home: homeFollowsUserData ? path.join(userData, 'gugu-home') : path.join(`${machineHome}-accounts`, userId),
    root: false,
  }
}

/** Each account's tmux server is its own: the root account keeps the label it always had, so its terminals survive. */
export function accountTmuxLabel(base: string, layout: AccountLayout): string {
  return layout.root || !layout.userId ? base : `${base}-${layout.userId.slice(0, 8)}`
}

export type AccountEntry =
  /** This process already serves this account. */
  | { kind: 'here' }
  /** This process serves the original directories and nobody owns them yet: this account takes them, no relaunch. */
  | { kind: 'claim'; registry: AccountRegistry }
  /** Another account's process: relaunch into this account's directories. */
  | { kind: 'switch'; registry: AccountRegistry }

export function decideAccountEntry(input: { processAccount: string | null; registry: AccountRegistry; userId: string }): AccountEntry {
  const { processAccount, registry, userId } = input
  if (!isAccountId(userId)) throw new Error('Invalid account id')
  if (processAccount === userId) return { kind: 'here' }
  if (processAccount === null) {
    if (registry.rootOwner === null) return { kind: 'claim', registry: { version: 1, rootOwner: userId, current: userId } }
    if (registry.rootOwner === userId) return { kind: 'claim', registry: { ...registry, current: userId } }
  }
  return { kind: 'switch', registry: { ...registry, current: userId } }
}

export type AccountHandoff = { user_id: string; access_token: string; refresh_token: string }

/** The signed-in session, carried once from the previous account's process into this account's first window. */
export function writeAccountHandoff(accountUserData: string, handoff: AccountHandoff): void {
  if (!isAccountId(handoff.user_id) || !handoff.access_token || !handoff.refresh_token) throw new Error('Invalid account handoff')
  writePrivateJson(path.join(accountUserData, ACCOUNT_HANDOFF_FILE), handoff)
}

/** One read: the file is gone before the session is returned, and a handoff for another account is discarded. */
export function takeAccountHandoff(accountUserData: string, userId: string | null): AccountHandoff | null {
  const file = path.join(accountUserData, ACCOUNT_HANDOFF_FILE)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  fs.rmSync(file, { force: true })
  const value = JSON.parse(raw) as Partial<AccountHandoff>
  if (value.user_id !== userId || typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string') return null
  return { user_id: value.user_id, access_token: value.access_token, refresh_token: value.refresh_token }
}

function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}
