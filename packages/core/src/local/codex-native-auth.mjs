import { loopbackFetch } from './loopback.ts'

/** Native OAuth stays with Codex. Only access-token projections cross the host boundary. */
export const CODEX_NATIVE_AUTH_ENDPOINT = 'GUGU_CODEX_NATIVE_AUTH_ENDPOINT'
export const CODEX_NATIVE_AUTH_BEARER = 'GUGU_CODEX_NATIVE_AUTH_BEARER'
export const CODEX_NATIVE_AUTH_ROOT = 'GUGU_CODEX_NATIVE_AUTH_ROOT'
export const CODEX_REFRESH_WINDOW_MS = 5 * 60 * 1000
const LEGACY_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function text(value) { return typeof value === 'string' && value.length > 0 ? value : null }

export function codexJwtClaims(value) {
  if (typeof value !== 'string') return null
  try { return record(JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString('utf8'))) }
  catch { return null }
}

/** account_id is a workspace, not a person. Never collapse two members of one workspace. */
export function codexOAuthIdentity(auth) {
  const value = record(auth)
  if (!value || (value.auth_mode ?? (value.OPENAI_API_KEY != null ? 'apikey' : 'chatgpt')) !== 'chatgpt') return null
  const tokens = record(value.tokens)
  const claims = codexJwtClaims(tokens?.id_token)
  const details = record(claims?.['https://api.openai.com/auth'])
  const stored = text(tokens?.account_id)
  const claimed = text(details?.chatgpt_account_id)
  if (stored && claimed && stored !== claimed) return null
  const workspace = stored ?? claimed
  const person = text(details?.chatgpt_user_id) ?? text(details?.user_id) ?? text(claims?.sub)
  return person && workspace ? JSON.stringify(['chatgpt', person, workspace]) : null
}

/** Same conditions as Codex 0.167.2 AuthManager::proactive_refresh_reason; no timer. */
export function codexNativeNeedsRefresh(auth, now = Date.now()) {
  if (!codexOAuthIdentity(auth)) return false
  const claims = codexJwtClaims(auth.tokens?.access_token)
  if (typeof claims?.exp === 'number' && Number.isFinite(claims.exp)) return claims.exp * 1000 <= now + CODEX_REFRESH_WINDOW_MS
  const last = typeof auth.last_refresh === 'string' ? Date.parse(auth.last_refresh) : NaN
  return Number.isFinite(last) && last < now - LEGACY_REFRESH_INTERVAL_MS
}

export function codexAccessProjection(auth, expectedIdentity) {
  const identity = codexOAuthIdentity(auth)
  if (!identity || expectedIdentity && identity !== expectedIdentity) throw new Error('Codex native account changed or cannot be identified; select its connection again')
  const accessToken = text(auth.tokens?.access_token)
  if (!accessToken) throw new Error('Codex native sign-in has no access token; run codex login')
  const claims = codexJwtClaims(auth.tokens.id_token)
  const details = record(claims?.['https://api.openai.com/auth'])
  const accountId = text(auth.tokens.account_id) ?? text(details?.chatgpt_account_id)
  const expires = codexJwtClaims(accessToken)?.exp
  return {
    identity,
    accessToken,
    chatgptAccountId: accountId,
    ...(text(details?.chatgpt_plan_type) ? { chatgptPlanType: details.chatgpt_plan_type } : {}),
    ...(text(claims?.email) ? { account: claims.email } : {}),
    ...(typeof expires === 'number' && Number.isFinite(expires) ? { expiresAt: expires * 1000 } : {}),
    // Deliberate allowlist: never spread the source document/tokens (it contains the RT).
    credentials: { auth_mode: 'chatgpt', tokens: {
      id_token: auth.tokens.id_token, access_token: accessToken,
      account_id: accountId,
    } },
  }
}

/** All consumers on the credential-owning host use this queue and its injected interprocess guard. */
export function createCodexNativeAuthAuthority({ read, refresh, serialize, identity, now = Date.now }) {
  let pending = null
  let revoked = null
  return async function access({ useToken = false, unauthorizedToken } = {}) {
    const original = await read()
    if (!original) return null
    const before = codexAccessProjection(original, identity)
    if (revoked?.token === before.accessToken) throw revoked.error
    revoked = null
    if (!useToken) return before
    const needs = (auth, view) => codexNativeNeedsRefresh(auth, now()) || unauthorizedToken === view.accessToken
    if (!needs(original, before)) return before
    if (pending) return pending
    const work = serialize(async () => {
      // Read after admission too: another CLI may have refreshed while we waited.
      const current = await read()
      const view = codexAccessProjection(current, identity)
      if (!needs(current, view)) return view
      let failure
      try { await refresh({ accessToken: view.accessToken }) } catch (error) { failure = error }
      const updated = codexAccessProjection(await read(), identity)
      if (updated.accessToken !== view.accessToken && (updated.expiresAt === undefined || updated.expiresAt > now())) return updated
      if (failure instanceof Error && /refresh token.*(?:revoked|reused)|refresh_token_(?:revoked|reused)/i.test(failure.message)) revoked = { token: view.accessToken, error: failure }
      // RPC success/account presence is not evidence that refresh/persistence succeeded.
      throw failure ?? new Error('Codex did not persist a usable refreshed native sign-in; run codex login')
    })
    pending = work
    try { return await work }
    finally { if (pending === work) pending = null }
  }
}

/** CLI startup can itself renew auth. Do not force a second exchange after its initialize. */
export async function refreshNativeCodexThroughCli(run, { read, identity, accessToken }) {
  await run(async server => {
    const initialized = codexAccessProjection(await read(), identity)
    if (initialized.accessToken !== accessToken && (initialized.expiresAt === undefined || initialized.expiresAt > Date.now())) return
    await server.request('account/read', { refreshToken: true })
  })
}

/** Used by ACP/TUI/status/usage; no source RT and no OAuth endpoint in this client. */
export async function requestNativeCodexAccess(env, options = {}, timeoutMs = options.useToken ? 65_000 : 10_000) {
  const endpoint = env[CODEX_NATIVE_AUTH_ENDPOINT]
  if (!endpoint) return null
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Invalid local Codex credential endpoint')
  const bearer = env[CODEX_NATIVE_AUTH_BEARER]
  if (!bearer) throw new Error('The native Codex credential route has no authorization')
  // The endpoint is the host's own loopback server: the local transport, never a proxy.
  const response = await loopbackFetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(options), signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    // Host errors are structured, never echo an upstream response that could contain tokens.
    const result = await response.json().catch(() => null)
    const revoked = result?.reason === 'revoked'
    throw new Error(revoked ? 'Codex refresh token was revoked: 登录被另一个客户端顶掉了，请运行 codex login 重新登录。'
      : 'Codex native sign-in is unavailable; check the connection or run codex login')
  }
  return response.json()
}

/** The managed conversation root must not load any saved OAuth before external auth is installed. */
export function nativeCodexSessionArgs(env) {
  return env[CODEX_NATIVE_AUTH_ROOT] ? ['-c', 'cli_auth_credentials_store="ephemeral"'] : []
}

/** One implementation for both app-server surfaces. Platform/API routes do not install native OAuth. */
export async function initializeNativeCodexSession(env, request, { platform = false, setRefresh } = {}) {
  setRefresh?.(null)
  if (env[CODEX_NATIVE_AUTH_ROOT] && !env[CODEX_NATIVE_AUTH_ENDPOINT] && !platform) throw new Error('Authentication required: run codex login to sign in to the native Codex account')
  if (!env[CODEX_NATIVE_AUTH_ENDPOINT] || platform) return null
  let current = await requestNativeCodexAccess(env, { useToken: true })
  if (!current) throw new Error('Authentication required: run codex login to sign in to the native Codex account')
  const payload = value => ({
    accessToken: value.accessToken, chatgptAccountId: value.chatgptAccountId,
    ...(value.chatgptPlanType ? { chatgptPlanType: value.chatgptPlanType } : {}),
  })
  const session = {
    async ensure() {
      const updated = await requestNativeCodexAccess(env, { useToken: true })
      if (!updated || updated.identity !== current.identity) throw new Error('Native Codex account changed; select its connection again')
      if (updated.accessToken !== current.accessToken) {
        await request('account/login/start', { type: 'chatgptAuthTokens', ...payload(updated) })
        current = updated
      }
    },
    async refresh(params) {
      if (params?.previousAccountId && params.previousAccountId !== current.chatgptAccountId) throw new Error('Native Codex workspace changed')
      // Official external callback expires after 10s. The host operation may continue, but this reply cannot hang.
      const updated = await requestNativeCodexAccess(env, { useToken: true, unauthorizedToken: current.accessToken }, 9_000)
      if (!updated || updated.identity !== current.identity || updated.accessToken === current.accessToken) throw new Error('Native Codex sign-in needs recovery; run codex login')
      current = updated
      return payload(current)
    },
  }
  setRefresh?.(session.refresh)
  try { await request('account/login/start', { type: 'chatgptAuthTokens', ...payload(current) }) }
  catch (error) { setRefresh?.(null); throw error }
  return session
}
