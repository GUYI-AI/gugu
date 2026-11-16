const LOGIN_ERROR_HOSTS = new Set(['gugu.nextmind.space'])
const BARE_HK_ADDRESS = 'gugu.nextmind.space/hk'
const BARE_HK_PREFIX = /(?:^|[\s(\[{"'“‘（【「『，。！？；、])$/u
const BARE_HK_SUFFIX = /^(?:$|[\s)\]}"'”’）】」』，。！？；、]|[.,;!?](?=$|[\s)\]}"'”’）】」』，。！？；、]))/u
// Mask whole URL-like tokens, including their quotes and brackets, before finding bare addresses.
const URL_TOKEN = /(?:[a-z][a-z0-9+.-]*:|\/\/|[?#]|[^\s()\[\]{}<>"'“”‘’，。！？；、（）【】「」『』]+[\/?#=])[^\s]*/gi

export type LoginErrorPart = { text: string; href?: string }

/** Login errors accept official HTTPS URLs and the one bare Hong Kong recovery address. */
export function loginErrorParts(message: string): LoginErrorPart[] {
  const parts: LoginErrorPart[] = []
  const urlTokens = [...message.matchAll(URL_TOKEN)].map(match => ({ start: match.index, end: match.index + match[0].length }))
  let start = 0
  for (const match of message.matchAll(/https?:\/\/[^\s<>"'，。！？；、）】」』]+|gugu\.nextmind\.space\/hk/gi)) {
    const text = match[0].replace(/[)\]},.;!?]+$/u, '')
    const bare = text.toLowerCase() === BARE_HK_ADDRESS && text.endsWith('/hk')
    if (bare && (urlTokens.some(token => token.start < match.index && match.index < token.end)
      || !BARE_HK_PREFIX.test(message.slice(0, match.index))
      || !BARE_HK_SUFFIX.test(message.slice(match.index + text.length)))) continue
    let url: URL
    try { url = new URL(bare ? `https://${BARE_HK_ADDRESS}` : text) } catch { continue }
    if (url.protocol !== 'https:' || !LOGIN_ERROR_HOSTS.has(url.hostname)
      || url.username || url.password || url.port) continue
    if (match.index > start) parts.push({ text: message.slice(start, match.index) })
    parts.push({ text, href: url.href })
    start = match.index + text.length
  }
  if (start < message.length || !parts.length) parts.push({ text: message.slice(start) })
  return parts
}
