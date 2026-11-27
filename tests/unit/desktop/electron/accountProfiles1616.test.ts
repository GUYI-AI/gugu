import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_HANDOFF_FILE, accountLayout, accountTmuxLabel, adoptLegacyOwner, decideAccountEntry, readAccountRegistry,
  takeAccountHandoff, writeAccountHandoff, writeAccountRegistry, type AccountRegistry,
} from '../../../../apps/desktop/electron/account-profiles'

const A = '0ba04326-e375-46b0-942a-76d20f1cd7da'
const B = '85dd1d88-8e71-4749-858c-7e24ae7b4f88'
const C = 'c92c15b6-0000-4000-8000-000000000003'
const dirs: string[] = []
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-profiles-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const layoutOf = (registry: AccountRegistry, userId: string | null, homeFollowsUserData = false) =>
  accountLayout({ machineUserData: '/data/Gugu', machineHome: '/home/u/.gugu', homeFollowsUserData, registry, userId })
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep)

describe('gugu-dev#1616 one account per process: directories', () => {
  const registry: AccountRegistry = { version: 1, rootOwner: A, current: A }

  it('keeps the first account in the original directories, so an upgrade moves nothing', () => {
    expect(layoutOf(registry, A)).toEqual({ userId: A, userData: '/data/Gugu', home: '/home/u/.gugu', root: true })
  })

  it('gives every later account sibling directories that no other account contains', () => {
    const layouts = [A, B, C].map((id) => layoutOf(registry, id))
    for (const homeFollows of [false, true]) layouts.push(...[A, B, C].map((id) => layoutOf(registry, id, homeFollows)))
    for (const one of layouts) for (const other of layouts) {
      if (one.userId === other.userId) continue
      for (const mine of [one.userData, one.home]) for (const theirs of [other.userData, other.home]) {
        expect(within(mine, theirs), `${mine} inside ${theirs}`).toBe(false)
      }
    }
    expect(layoutOf(registry, B)).toEqual({ userId: B, userData: `/data/Gugu-accounts/${B}`, home: `/home/u/.gugu-accounts/${B}`, root: false })
    expect(layoutOf(registry, B, true).home).toBe(`/data/Gugu-accounts/${B}/gugu-home`)
  })

  it('refuses an account id that could leave its directory', () => {
    expect(() => layoutOf(registry, '../escape')).toThrow('Invalid account id')
  })

  it('gives each later account its own tmux server and keeps the first one on the label it had', () => {
    expect(accountTmuxLabel('gugu', layoutOf(registry, A))).toBe('gugu')
    expect(accountTmuxLabel('gugu', layoutOf(registry, B))).toBe('gugu-85dd1d88')
  })
})

describe('gugu-dev#1616 who owns the original directories', () => {
  it('is the account the desktop was signed in to before the upgrade', () => {
    expect(adoptLegacyOwner({ version: 1, rootOwner: null, current: null }, A)).toEqual({ version: 1, rootOwner: A, current: A })
  })

  it('stays unclaimed when nobody was signed in, and an existing owner never changes', () => {
    const empty: AccountRegistry = { version: 1, rootOwner: null, current: null }
    expect(adoptLegacyOwner(empty, null)).toBe(empty)
    const owned: AccountRegistry = { version: 1, rootOwner: A, current: B }
    expect(adoptLegacyOwner(owned, C)).toBe(owned)
  })

  it('reads a missing registry as unclaimed and refuses a damaged one instead of sharing the directories', () => {
    const dir = temp()
    expect(readAccountRegistry(dir)).toEqual({ version: 1, rootOwner: null, current: null })
    writeAccountRegistry(dir, { version: 1, rootOwner: A, current: B })
    expect(readAccountRegistry(dir)).toEqual({ version: 1, rootOwner: A, current: B })
    fs.writeFileSync(path.join(dir, 'account-profiles.json'), JSON.stringify({ version: 1, rootOwner: '../x', current: null }))
    expect(() => readAccountRegistry(dir)).toThrow('Invalid account registry')
  })
})

describe('gugu-dev#1616 signing in', () => {
  it('stays in this process for the account it serves', () => {
    expect(decideAccountEntry({ processAccount: A, registry: { version: 1, rootOwner: A, current: A }, userId: A })).toEqual({ kind: 'here' })
  })

  it('lets the first account to sign in on an unclaimed machine take the original directories without a relaunch', () => {
    expect(decideAccountEntry({ processAccount: null, registry: { version: 1, rootOwner: null, current: null }, userId: B }))
      .toEqual({ kind: 'claim', registry: { version: 1, rootOwner: B, current: B } })
  })

  it('relaunches for any other account, which never reads the signed-out account directories', () => {
    expect(decideAccountEntry({ processAccount: A, registry: { version: 1, rootOwner: A, current: A }, userId: B }))
      .toEqual({ kind: 'switch', registry: { version: 1, rootOwner: A, current: B } })
    expect(decideAccountEntry({ processAccount: B, registry: { version: 1, rootOwner: A, current: B }, userId: A }))
      .toEqual({ kind: 'switch', registry: { version: 1, rootOwner: A, current: A } })
    expect(decideAccountEntry({ processAccount: null, registry: { version: 1, rootOwner: A, current: null }, userId: B }).kind).toBe('switch')
  })
})

describe('gugu-dev#1616 where the sign-in lands after a switch', () => {
  it('is carried into the next account\'s own userData once, and nowhere else', () => {
    const machine = temp()
    const registry: AccountRegistry = { version: 1, rootOwner: A, current: B }
    const a = accountLayout({ machineUserData: machine, machineHome: path.join(machine, 'home'), homeFollowsUserData: false, registry, userId: A })
    const b = accountLayout({ machineUserData: machine, machineHome: path.join(machine, 'home'), homeFollowsUserData: false, registry, userId: B })
    writeAccountHandoff(b.userData, { user_id: B, access_token: 'access', refresh_token: 'refresh' })

    expect(fs.existsSync(path.join(a.userData, ACCOUNT_HANDOFF_FILE))).toBe(false)
    expect((fs.statSync(path.join(b.userData, ACCOUNT_HANDOFF_FILE)).mode & 0o777).toString(8)).toBe('600')
    expect(takeAccountHandoff(a.userData, A)).toBeNull()
    expect(takeAccountHandoff(b.userData, B)).toEqual({ user_id: B, access_token: 'access', refresh_token: 'refresh' })
    expect(takeAccountHandoff(b.userData, B)).toBeNull()
  })

  it('discards a session handed to another account than the one this process serves', () => {
    const dir = temp()
    writeAccountHandoff(dir, { user_id: B, access_token: 'access', refresh_token: 'refresh' })
    expect(takeAccountHandoff(dir, A)).toBeNull()
    expect(fs.existsSync(path.join(dir, ACCOUNT_HANDOFF_FILE))).toBe(false)
  })
})
