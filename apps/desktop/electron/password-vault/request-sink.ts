import { VaultError } from './contracts'
import { credentialServes } from './schema'

/**
 * One https request carrying a saved value in one header (`LocalPasswordVault.request`). The caller names where it goes and
 * which header; the value goes nowhere else — not the URL, not the body, not another header, not a redirect elsewhere.
 * `hosts`: where the caller may reach at all (an App's `permissions.network`, the connector's own API host).
 */
export interface CredentialRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  hosts: readonly string[]
  header: string
  /** How the header reads, `{value}` standing for the saved value (`Bearer {value}`). */
  format: string
  value: 'password' | 'account' | { field: string }
  body?: string
  /** Extra plain headers the caller sends (Accept, an API version). Never the credential's header. */
  headers?: Readonly<Record<string, string>>
}
export interface CredentialResponse { status: number; data: unknown; headers: Record<string, string> }

/** Headers a credential may go into: never one the platform owns (Cookie, Host) or that steers the request elsewhere. */
export const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'private-token', 'x-auth-token'] as const
/** Response headers handed back: what a client needs to page and to back off, nothing that could carry a value back. */
const ANSWER_HEADERS = ['content-type', 'link', 'etag', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']
const PLAIN_HEADERS = /^(?:accept|content-type|if-none-match|x-[a-z-]+-api-version)$/i
const MAX_ANSWER = 8 * 1024 * 1024

const refuse = () => new VaultError('INVALID_INPUT')

/** Where a request may go: https on 443, a host the caller may reach and the credential serves, never an address. */
export function credentialRequestUrl(credential: { origin: string; sites: readonly string[] }, request: Pick<CredentialRequest, 'url' | 'hosts'>): URL {
  let url: URL
  try { url = new URL(request.url) } catch { throw refuse() }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw refuse()
  if (/^[\d.]+$/.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.local')) throw refuse()
  if (!request.hosts.some(allowed => allowed.startsWith('*.') ? host === allowed.slice(2) || host.endsWith(allowed.slice(1)) : host === allowed)) throw refuse()
  if (!credentialServes(credential, host)) throw refuse()
  return url
}

export async function sendWithCredential(http: typeof fetch, credential: { origin: string; sites: readonly string[] }, request: CredentialRequest,
  value: Buffer, signal?: AbortSignal): Promise<CredentialResponse> {
  const url = credentialRequestUrl(credential, request)
  const header = request.header.toLowerCase()
  if (!(CREDENTIAL_HEADERS as readonly string[]).includes(header) || request.format.split('{value}').length !== 2) throw refuse()
  const text = value.toString('utf8')
  // A value that could end the header line would let it write more headers: refuse it, never trim it.
  if (/[\r\n\0]/.test(text)) throw new VaultError('INVALID_INPUT')
  const headers: Record<string, string> = {}
  for (const [name, plain] of Object.entries(request.headers ?? {})) {
    if (!PLAIN_HEADERS.test(name) || /[\r\n]/.test(plain)) throw refuse()
    headers[name] = plain
  }
  headers[header] = request.format.replace('{value}', text)
  let response: Response
  try {
    // `manual`: a redirect comes back as the answer, so the header never follows it to another place.
    response = await http(url, { method: request.method, headers, redirect: 'manual', signal,
      ...(request.body !== undefined && request.method !== 'GET' ? { body: request.body } : {}) })
  } catch (error) {
    if (signal?.aborted) throw new VaultError('CANCELLED')
    throw Object.assign(new VaultError('UNAVAILABLE'), { network: error instanceof Error ? error.message : String(error) })
  } finally { headers[header] = '' }
  const raw = await response.arrayBuffer()
  if (raw.byteLength > MAX_ANSWER) throw new VaultError('UNAVAILABLE')
  const body = Buffer.from(raw).toString('utf8')
  let data: unknown = body
  if ((response.headers.get('content-type') ?? '').includes('json') && body) {
    try { data = JSON.parse(body) } catch { data = body } // Said JSON, sent something else: the text as it came.
  }
  const answer: Record<string, string> = {}
  for (const name of ANSWER_HEADERS) { const entry = response.headers.get(name); if (entry !== null) answer[name] = entry }
  return { status: response.status, data, headers: answer }
}
