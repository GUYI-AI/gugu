import { passwordGrantLevel, type PasswordItem } from '@gugu/core/shared/passwordBetaProtocol'

/** What an Agent sees of one credential. Secret values never; non-secret ones (the account unless marked secret, fields
 * marked non-secret) only with access (read/write) to it. Without access: names and the masked account. */
export interface AgentCredential {
  credentialId: string; name: string; origin: string; account?: string; maskedAccount?: string; hasPassword: boolean
  fields: { name: string; secret: boolean; value?: string }[]; sites: string[]; access: 'ask' | 'read' | 'write'
}
const hostOf = (origin: string) => { try { return new URL(origin).hostname } catch { return '' } }

export function agentCredential(item: PasswordItem, subjects: readonly string[]): AgentCredential {
  const access = passwordGrantLevel(item.grants, subjects) ?? 'ask', open = access !== 'ask'
  return {
    credentialId: item.reference.id, name: item.name || hostOf(item.origin), origin: item.origin,
    ...(open && item.account !== undefined ? { account: item.account } : item.maskedAccount ? { maskedAccount: item.maskedAccount } : {}),
    hasPassword: item.hasPassword,
    fields: item.fields.map(field => ({ name: field.name, secret: field.secret, ...(open && !field.secret && field.value !== undefined ? { value: field.value } : {}) })),
    sites: [...item.sites], access,
  }
}

export interface CredentialSearch {
  /** A website: matches it and its subdomains, on the credential's own site or the sites it may be filled into. */
  site?: string
  /** Free text over name, website and field names; and over readable non-secret values. */
  query?: string
  /** Only credentials with a value of this name ("API Key"; "account"/"password" for those two). */
  field?: string
  /** Only those usable without asking (read/write access). */
  usable?: boolean
  /** 1-based "1-20" (default) or "21-40". */
  rows?: string
}
const ACCESS_ORDER = { write: 0, read: 1, ask: 2 } as const
function siteMatches(origin: string, site: string): boolean {
  const host = hostOf(origin), wanted = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/^\*\./, '')
  return !!wanted && (host === wanted || host.endsWith('.' + wanted))
}
function rowRange(rows: string | undefined, total: number): [number, number] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(rows?.trim() ?? '')
  const first = match ? Math.max(1, Number(match[1])) : 1
  const last = match?.[2] ? Math.max(first, Number(match[2])) : match && !match[2] ? first + 19 : 20
  return [first, Math.min(last, first + 99, total)]
}

/** Filter, order (usable first, then by name) and page the Agent's view. Searching non-secret values covers only
 * credentials the Agent may read: matching values of the others would reveal them one guess at a time. */
export function searchCredentials(items: readonly AgentCredential[], search: CredentialSearch = {}) {
  const query = search.query?.trim().toLowerCase(), field = search.field?.trim().toLowerCase()
  const matches = items.filter(item => {
    if (search.usable && item.access === 'ask') return false
    if (search.site && ![item.origin, ...item.sites].some(origin => siteMatches(origin, search.site!))) return false
    if (field) {
      const names = [...item.fields.map(entry => entry.name.toLowerCase()), ...(item.account || item.maskedAccount ? ['account', '账号'] : []), ...(item.hasPassword ? ['password', '密码'] : [])]
      if (!names.includes(field)) return false
    }
    if (query) {
      const text = [item.name, hostOf(item.origin), ...item.sites.map(hostOf), ...item.fields.map(entry => entry.name),
        ...(item.access === 'ask' ? [] : [item.account ?? '', ...item.fields.map(entry => entry.value ?? '')])].join('\n').toLowerCase()
      if (!text.includes(query)) return false
    }
    return true
  }).sort((a, b) => ACCESS_ORDER[a.access] - ACCESS_ORDER[b.access] || a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin))
  const [first, last] = rowRange(search.rows, matches.length)
  const page = matches.slice(first - 1, last)
  return { total: matches.length, rows: page.length ? `${first}-${first + page.length - 1}` : '', items: page,
    ...(last < matches.length ? { next: `${last + 1}-${Math.min(matches.length, last + (last - first + 1))}` } : {}) }
}

export interface AgentSaveInput { name?: string; account?: string; accountSecret?: boolean; password?: string; fields?: { name: string; value?: string; secret?: boolean }[] }
/**
 * An Agent's change to a credential it may write, as the fields to save; or `null` when the person has to do it:
 * without write access, when a secret value would stop being secret, or when a new value comes without its value.
 * Values the Agent leaves out keep the stored ones (blank); an Agent may always make a value secret.
 */
export function planAgentSave(item: PasswordItem | undefined, subjects: readonly string[], input: AgentSaveInput, id: () => string) {
  if (!item || passwordGrantLevel(item.grants, subjects) !== 'write') return null
  const proposed = new Map((input.fields ?? []).map(field => [field.name, field] as const))
  if (input.accountSecret === false && item.accountSecret) return null
  if (item.fields.some(field => field.secret && proposed.get(field.name)?.secret === false)) return null
  const added = [...proposed.values()].filter(field => !item.fields.some(entry => entry.name === field.name))
  if (added.some(field => !field.value)) return null
  return [...item.fields.map(field => ({ id: field.id, name: field.name, value: proposed.get(field.name)?.value ?? '', secret: proposed.get(field.name)?.secret ?? field.secret })),
    ...added.map(field => ({ id: id(), name: field.name, value: field.value!, secret: field.secret ?? true }))]
}
