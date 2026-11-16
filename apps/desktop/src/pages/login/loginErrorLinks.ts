const LOGIN_ERROR_HOSTS = new Set(['gugu.nextmind.space'])

export type LoginErrorPart = { text: string; href?: string }

/** Only the login error surface may turn an official HTTPS destination into a link. */
export function loginErrorParts(message: string): LoginErrorPart[] {
  const parts: LoginErrorPart[] = []
  let start = 0
  for (const match of message.matchAll(/https?:\/\/[^\s<>"'，。！？；、）】」』]+/gi)) {
    const text = match[0].replace(/[)\]},.;!?]+$/u, '')
    let url: URL
    try { url = new URL(text) } catch { continue }
    if (url.protocol !== 'https:' || !LOGIN_ERROR_HOSTS.has(url.hostname)
      || url.username || url.password || url.port) continue
    if (match.index > start) parts.push({ text: message.slice(start, match.index) })
    parts.push({ text, href: url.href })
    start = match.index + text.length
  }
  if (start < message.length || !parts.length) parts.push({ text: message.slice(start) })
  return parts
}
