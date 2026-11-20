import type { SiteCredential } from '../../../../apps/desktop/electron/password-vault/beta-host'
import { VaultError } from '../../../../apps/desktop/electron/password-vault/contracts'

/** An in-memory stand-in for `passwordVaultForHost`: the same choice rule (one credential per user and website). */
export function fakeVaultForHost() {
  const items: (SiteCredential & { password: string })[] = []
  const serves = (item: SiteCredential, site: string) => { const own = new URL(item.origin).hostname; return site === own || site.endsWith('.' + own) }
  const view = (item: SiteCredential & { password: string }): SiteCredential => { const { password: _secret, ...rest } = item; return JSON.parse(JSON.stringify(rest)) }
  const requests: { subject: string; site: string; credentialId?: string; request: { url: string; header: string; hosts: readonly string[] } }[] = []
  let failure: VaultError | null = null
  const api = {
    items, requests, fail(code: ConstructorParameters<typeof VaultError>[0] | null) { failure = code ? new VaultError(code) : null },
    async siteCredentials(site: string) { if (failure) throw failure; return items.filter(item => serves(item, site)).map(view) },
    async credentials() { if (failure) throw failure; return items.map(view) },
    async assign(subject: string, site: string, credentialId: string | null, code?: string) {
      if (failure) throw failure
      for (const item of items) if (serves(item, site)) item.users = item.users.filter(user => user.subject !== subject)
      if (credentialId) items.find(item => item.id === credentialId)!.users.push({ subject, ...(code ? { code } : {}) })
    },
    async save(input: { origin: string; name: string; account: string; password: string; fields?: Record<string, string> }, credentialId?: string) {
      if (failure) throw failure
      const existing = credentialId ? items.find(item => item.id === credentialId) : undefined
      if (existing) { Object.assign(existing, { account: input.account, password: input.password, fields: { ...existing.fields, ...input.fields } }); return existing.id }
      const id = `00000000-0000-4000-8000-${String(items.length + 1).padStart(12, '0')}`
      items.push({ id, name: input.name, origin: input.origin, account: input.account, maskedAccount: '***', fields: { ...input.fields }, users: [], password: input.password })
      return id
    },
    async request(subject: string, site: string, _code: string | undefined, request: { url: string; header: string; hosts: readonly string[] }, _signal?: AbortSignal, credentialId?: string) {
      if (failure) throw failure
      requests.push({ subject, site, request, ...(credentialId ? { credentialId } : {}) })
      const chosen = items.filter(item => serves(item, site) && (credentialId ? item.id === credentialId : item.users.some(user => user.subject === subject)))
      if (chosen.length !== 1) throw new VaultError('NOT_GRANTED')
      return { status: 200, data: { login: chosen[0].account }, headers: { 'content-type': 'application/json' } }
    },
  }
  return api
}
