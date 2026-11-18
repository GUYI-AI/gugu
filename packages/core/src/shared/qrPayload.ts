export type GuguQrPayload = GuguGroupInviteQrPayload | GuguContactQrPayload

export type GuguGroupInviteQrPayload = {
  version: 1
  kind: 'group_invite'
  group_public_id: number
  // @@@group-join-token (#653) - the group's unguessable invite secret. Direct join requires it (the
  join_token?: string
}

// @@@contact-qr (#537) - a personal "add me" QR: encodes the owner's 咕咕号 (gugu_number) so a scan/paste
// resolves straight to that user in the add-friend search. Same envelope as the group invite payload.
export type GuguContactQrPayload = {
  version: 1
  kind: 'contact'
  gugu_number: number
}

/**
 * @@@short-qr - every QR / share link the app makes is `https://gugu.nextmind.space/j/?<code>`:
 *   group invite  `<public_id>.<join_token as base64url>`  (16-byte hex token → 22 chars; ≤ 60 chars in all)
 *   contact       `<gugu_number>`
 * The official site serves `j/index.html` (GUYI-AI/gugu-website): it sends a phone camera / WeChat scan to the
 * App (`gugu://…/j/?<code>`) or to the download for that platform. The site is static, so the code rides in the
 * query, not the path. The in-app scanner reads the code directly and never opens the page.
 */
export const GUGU_SHORT_LINK_BASE = 'https://gugu.nextmind.space/j/'

// Codes printed before the short link (posters, README) were `<any url>?gugu_qr=<JSON>`. Read-only.
const LEGACY_QR_PARAM = 'gugu_qr'

const GROUP_CODE = /^(\d+)\.([A-Za-z0-9_-]{22})$/
const CONTACT_CODE = /^(\d+)$/
const HEX_TOKEN = /^[0-9a-f]{32}$/i

export function createGroupInviteQrPayload(groupPublicId: number, joinToken?: string): GuguGroupInviteQrPayload {
  if (!isPositiveInteger(groupPublicId)) {
    throw new Error('Group invite QR payload requires a positive integer group_public_id')
  }
  const token = joinToken?.trim()
  return {
    version: 1,
    kind: 'group_invite',
    group_public_id: groupPublicId,
    ...(token ? { join_token: token } : {}),
  }
}

export function createContactQrPayload(guguNumber: number): GuguContactQrPayload {
  if (!isPositiveInteger(guguNumber)) {
    throw new Error('Contact QR payload requires a positive integer gugu_number')
  }
  return {
    version: 1,
    kind: 'contact',
    gugu_number: guguNumber,
  }
}

/** The one encoder for every QR and share link. */
export function createGuguQrUrl(payload: GuguQrPayload): string {
  const id = payload.kind === 'contact' ? payload.gugu_number : payload.group_public_id
  if (!isPositiveInteger(id)) throw new Error('QR link requires a positive safe integer id')
  if (payload.kind === 'contact') return `${GUGU_SHORT_LINK_BASE}?${payload.gugu_number}`
  const token = payload.join_token ?? ''
  // join_token is encode(gen_random_bytes(16), 'hex') in the database; anything else is a bug upstream.
  if (!HEX_TOKEN.test(token)) throw new Error('Group invite link requires a 32-hex join_token')
  return `${GUGU_SHORT_LINK_BASE}?${payload.group_public_id}.${hexToBase64Url(token)}`
}

export function parseGuguQrPayload(value: unknown): GuguQrPayload | null {
  if (typeof value === 'string') {
    const short = parseShortCode(value)
    if (short !== undefined) return short
  }
  const payload = unwrapQrPayload(value)
  if (!payload) return null
  if (payload.version !== 1) return null
  if (payload.kind === 'group_invite') {
    if (!isPositiveInteger(payload.group_public_id)) return null
    const token = typeof payload.join_token === 'string' && payload.join_token.trim() ? payload.join_token.trim() : undefined
    return { version: 1, kind: 'group_invite', group_public_id: payload.group_public_id, ...(token ? { join_token: token } : {}) }
  }
  if (payload.kind === 'contact') {
    if (!isPositiveInteger(payload.gugu_number)) return null
    return { version: 1, kind: 'contact', gugu_number: payload.gugu_number }
  }
  return null
}

/** A `…/j/?<code>` URL on any origin or scheme (the site hands `gugu://…` to the App). undefined = not a short link. */
function parseShortCode(value: string): GuguQrPayload | null | undefined {
  let url: URL
  try { url = new URL(value.trim()) } catch { return undefined }
  if (!/\/j\/?$/.test(url.pathname)) return undefined
  const code = url.search.slice(1)
  const group = GROUP_CODE.exec(code)
  if (group) {
    const id = Number(group[1])
    return isPositiveInteger(id) ? createGroupInviteQrPayload(id, base64UrlToHex(group[2]!)) : null
  }
  const contact = CONTACT_CODE.exec(code)
  if (contact) {
    const n = Number(contact[1])
    return isPositiveInteger(n) ? createContactQrPayload(n) : null
  }
  return null
}

function unwrapQrPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const urlPayload = parseLegacyQrUrl(value)
    if (urlPayload) return urlPayload
    try {
      const parsed = JSON.parse(value) as unknown
      return unwrapQrPayload(parsed)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const record = value as Record<string, unknown>
  if (record.payload && typeof record.payload === 'object') {
    if (Array.isArray(record.payload)) return null
    const wrappedPrototype = Object.getPrototypeOf(record.payload)
    if (wrappedPrototype !== Object.prototype && wrappedPrototype !== null) return null
    return record.payload as Record<string, unknown>
  }
  return record
}

function parseLegacyQrUrl(value: string): Record<string, unknown> | null {
  try {
    const url = new URL(value)
    const payload = url.searchParams.get(LEGACY_QR_PARAM)
    if (!payload) return null
    return unwrapQrPayload(JSON.parse(payload) as unknown)
  } catch {
    return null
  }
}

function hexToBase64Url(hex: string): string {
  const binary = String.fromCharCode(...hex.match(/../g)!.map((h) => parseInt(h, 16)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToHex(text: string): string {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Array.from(binary, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
