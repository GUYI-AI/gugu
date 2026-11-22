import { createClient, processLock } from '@supabase/supabase-js'
import { egress } from '../shared/egress'
import { getSupabaseAnonKey, getSupabaseUrl } from './config'
import { withServerClock } from '../shared/serverClock'

type SupabaseCreateOptions = NonNullable<Parameters<typeof createClient>[2]>

export interface GuguSupabaseStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export interface GuguSupabaseClientOptions {
  // @@@access-token-client — 提供后该 client 不再拥有自己的 GoTrue 会话:每个请求经回调取
  // Bearer(supabase-js 原生 accessToken 选项;误用其 .auth 会响亮抛错)。适合 schema 查询
  // client 跟随主 client 的令牌——彻底免去 setSession 同步(其内部强制远程 /auth/v1/user 来回)。
  accessToken?: () => Promise<string | null>
  anonKey?: string
  autoRefreshToken?: boolean
  flowType?: 'implicit' | 'pkce'
  /** Wraps the egress fetch (e.g. to observe answers or bound a request's life); it cannot replace it. */
  wrapFetch?: (next: typeof globalThis.fetch) => typeof globalThis.fetch
  headers?: Record<string, string>
  persistSession?: boolean
  /** Realtime options except the transport: every client's socket comes from the egress. */
  realtime?: Omit<NonNullable<SupabaseCreateOptions['realtime']>, 'transport'>
  schema?: string
  storage?: GuguSupabaseStorage
  storageKey?: string
  url?: string
}

export function createGuguSupabaseClient(options: GuguSupabaseClientOptions = {}) {
  const persistSession = options.persistSession ?? false
  const autoRefreshToken = options.autoRefreshToken ?? false
  if ((options.storage !== undefined || persistSession) && !options.storageKey) {
    throw new Error(
      'createGuguSupabaseClient: storageKey is required when storage is provided or persistSession is true'
    )
  }

  // @@@egress-supabase - every client reaches the backend through the egress: HTTP via its fetch, Realtime via its
  // WebSocket. Left to itself supabase-js would use the runtime's globals, which in a host process ignore the system
  // proxy. Injected here, once, so no call site can forget it.
  const egressFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.href
    const upload = /^(POST|PUT)$/i.test(init?.method ?? 'GET') && new URL(url).pathname.startsWith('/storage/v1/object/')
    return egress.fetch(input as string | URL | Request, { ...init, ...(upload ? { timeoutMs: 0 } : {}) })
  }) as typeof globalThis.fetch
  // Every client of our backend also tunes this runtime's server clock (`@@@server-clock`).
  const global = { headers: options.headers, fetch: withServerClock(options.wrapFetch ? options.wrapFetch(egressFetch) : egressFetch) }
  const realtime = { ...options.realtime, transport: EgressRealtimeSocket as never }

  // @@@access-token-client — accessToken 与自有 auth 互斥(supabase-js 约束):令牌客户端
  // 不建 GoTrue 会话,auth 相关选项一概不传。
  if (options.accessToken) {
    if (options.storage || options.storageKey || persistSession || autoRefreshToken) {
      throw new Error(
        'createGuguSupabaseClient: accessToken cannot be combined with storage/persistSession/autoRefreshToken'
      )
    }
    return createClient(options.url ?? getSupabaseUrl(), options.anonKey ?? getSupabaseAnonKey(), {
      accessToken: options.accessToken,
      db: options.schema ? { schema: options.schema } : undefined,
      global,
      realtime
    })
  }

  return createClient(options.url ?? getSupabaseUrl(), options.anonKey ?? getSupabaseAnonKey(), {
    auth: {
      storage: options.storage,
      storageKey: options.storageKey,
      persistSession,
      autoRefreshToken,
      flowType: options.flowType,
      detectSessionInUrl: false,
      // @@@electron-lock — gotrue defaults to the browser navigatorLock (Web Locks API) to serialize
      // getSession/refresh across TABS. Gugu's renderer is a single Electron context (no sibling tabs),
      // so that coordination buys nothing — and worse, the Web Lock orphans on a component unmount
      // (React StrictMode double-mount): "Lock sb-main not released within 5000ms" → every getSession /
      // realtime.setAuth / device-runtime token IPC then blocks ~5s, which starves realtime auth so
      // private channels never authorize and live broadcasts (agent replies, presence) get dropped.
      // processLock is an in-memory promise-chain mutex: it still serializes refreshes (no double-refresh
      // race) but is not tied to the navigator LockManager, so it can't orphan. Correct for Electron.
      // @@@3916 取锁**不设第二个更短的超时**。processLock 在 acquireTimeout >= 0 时会建一条会 reject 的
      // timeout promise;它 reject 之后若没有下一个等待者来 await,就成了未捕获异常落到页面上
      // (实测:令牌过期且续期续不上时,栈里没有任何 app 帧,应用无从 catch)。
      //
      // 去掉它之所以安全,是因为**「一次 auth 操作最多等多久」现在由 SessionCoordinator 自己的
      // AUTH_CALL_TIMEOUT_MS 命名并拥有**(getSession / refreshSession / signOut 各自套了预算)。
      // 每个持锁方都被那条预算兜住 ⇒ 等待方不会无限等 —— 这是**由构造保证**的,不是靠库里那个
      // 恰好是 5s 的 magic number。
      // ⚠️ 若将来有 auth 调用绕开协调器的预算直接打 GoTrue,这里就会变成真的无限等 ——
      // 那时该修的是那条绕开的路,不是把库的超时加回来。
      lock: (name, _acquireTimeout, fn) => processLock(name, -1, fn)
    },
    db: options.schema ? { schema: options.schema } : undefined,
    global,
    realtime
  })
}

export function dbPayload<T extends Record<string, unknown> | Record<string, unknown>[]>(
  value: T
): never {
  return value as never
}

/** realtime-js constructs its transport with `new transport(url, protocols)`; the egress gives the WHATWG socket. */
function EgressRealtimeSocket(url: string | URL, protocols?: string | string[]): globalThis.WebSocket {
  return egress.webSocket(url, { protocols })
}
