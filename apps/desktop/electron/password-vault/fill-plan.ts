import type { PasswordItem } from '@gugu/core/shared/passwordBetaProtocol'
import type { VaultFillValue } from './contracts'

/** One value to fill: `field` names it (账号/account, 密码/password, or a value's name); `code`: the current one-time
 * code from that value's TOTP seed; `value`: a value the Agent already knows (a username), never a secret; `into`: a CSS
 * selector for the input on the page. A value neither saved nor given is asked of the person on the card. */
export type FillEntry = { field: string; into: string; code?: boolean; value?: string }
export interface FillRequest { browserId?: string; url: string; fill: FillEntry[]; form?: string; submit?: string }
export type FillInvalid = { status: 'invalid_request'; retry: false; error: string }
/** Where a value comes from: the vault, the Agent (`given`), or the person on the card (`missing`). */
export type FillSource = 'saved' | 'given' | 'missing'
const ACCOUNT = ['账号', 'account', 'username', '用户名'], PASSWORD = ['密码', 'password']
export const invalid = (error: string): FillInvalid => ({ status: 'invalid_request', retry: false, error })
/** The person's name for a value: 账号 and 密码 for the login pair, else what the Agent called it. */
export const fillName = (field: string) => { const key = field.trim().toLowerCase(); return ACCOUNT.includes(key) ? '账号' : PASSWORD.includes(key) ? '密码' : field.trim() }

/**
 * The values named by an Agent as the vault's plan, or what was wrong (names only, never a value). Without a credential
 * (nothing saved for the website) every value is given or asked; with one, what it lacks is.
 */
export function resolveFill(item: PasswordItem | undefined, fill: readonly FillEntry[]):
  { values: VaultFillValue[]; names: string[]; secret: boolean[]; sources: FillSource[]; given: (string | undefined)[] } | FillInvalid {
  const values: VaultFillValue[] = [], names: string[] = [], secret: boolean[] = [], sources: FillSource[] = [], given: (string | undefined)[] = []
  for (const entry of fill) {
    if (typeof entry.field !== 'string' || !entry.field.trim() || entry.value !== undefined && (typeof entry.value !== 'string' || entry.value.length > 4096)) return invalid('Each fill names a value (field) and, optionally, a value you already know (value).')
    const name = entry.field.trim(), key = name.toLowerCase(), password = PASSWORD.includes(key)
    if (password && entry.value !== undefined) return invalid('Never pass a password as value: leave it out, and the person fills it in.')
    const field = item?.fields.find(value => value.name.trim().toLowerCase() === key)
    const stored = field ? (entry.code ? { kind: 'code', id: field.id } as const : { kind: 'field', id: field.id } as const)
      : !entry.code && ACCOUNT.includes(key) && (item?.account || item?.maskedAccount) ? { kind: 'account' } as const
        : !entry.code && password && item?.hasPassword ? { kind: 'password' } as const : undefined
    if (entry.code && !field) return invalid(`Nothing saved holds a TOTP seed named "${name}".`)
    // What is saved is what gets filled; a value the Agent passes only stands in for one that is not saved.
    const storedSecret = stored?.kind === 'field' ? field!.secret : stored?.kind === 'account' ? !!item?.accountSecret : stored?.kind === 'password'
    if (stored) {
      values.push(stored); names.push(entry.code ? `${field!.name} 的验证码` : fillName(field?.name ?? name)); secret.push(!entry.code && storedSecret); sources.push('saved'); given.push(undefined)
    } else {
      values.push({ kind: 'typed' }); names.push(fillName(name))
      // What the person types is kept hidden unless it is the account (or the Agent knew it anyway).
      secret.push(entry.value === undefined && !ACCOUNT.includes(key)); sources.push(entry.value === undefined ? 'missing' : 'given'); given.push(entry.value)
    }
  }
  return { values, names, secret, sources, given }
}
