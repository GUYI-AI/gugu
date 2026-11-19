import { DEFAULT_HANDSHAKE_TIMEOUT_MS, egressHost, type EgressBackend, type EgressError, type EgressErrorKind, type EgressWebSocketOptions } from '../egress'

/** A WHATWG socket whose opening deadline includes asynchronous proxy resolution and fallback. */
export function boundedWebSocket(
  backend: EgressBackend, url: string, options: EgressWebSocketOptions,
  fail: (kind: EgressErrorKind, host: string, cause: unknown) => EgressError,
): WebSocket {
  const abort = new AbortController()
  const host = egressHost(url)
  let raw: WebSocket | undefined
  let state = 0
  let binaryType: BinaryType = 'arraybuffer'
  let nativeError: unknown
  let failing = false
  const socket = new class extends EventTarget {
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    readonly url = url
    onopen: ((event: Event) => unknown) | null = null
    onmessage: ((event: MessageEvent) => unknown) | null = null
    onerror: ((event: Event) => unknown) | null = null
    onclose: ((event: CloseEvent) => unknown) | null = null
    get readyState() { return state }
    get bufferedAmount() { return raw?.bufferedAmount ?? 0 }
    get protocol() { return raw?.protocol ?? '' }
    get extensions() { return raw?.extensions ?? '' }
    get binaryType() { return binaryType }
    set binaryType(value: BinaryType) { binaryType = value; if (raw) raw.binaryType = value }
    send(data: Parameters<WebSocket['send']>[0]) {
      if (state !== 1 || !raw) throw new DOMException('WebSocket is not open', 'InvalidStateError')
      raw.send(data)
    }
    close(code?: number, reason?: string) {
      if (state >= 2) return
      clearTimeout(timer)
      state = 2
      abort.abort(new DOMException('WebSocket closed by caller', 'AbortError'))
      if (raw) raw.close(code, reason)
      else queueMicrotask(() => closed(1006, '', false))
    }
  }()
  const emit = (event: Event) => {
    socket.dispatchEvent(event)
    const handler = socket[`on${event.type}` as 'onopen']
    handler?.call(socket, event)
  }
  const closed = (code: number, reason: string, wasClean: boolean) => {
    if (state === 3) return
    clearTimeout(timer)
    state = 3
    emit(Object.assign(new Event('close'), { code, reason, wasClean }))
  }
  const failed = (cause: unknown, kind = backend.classify(cause) ?? 'connect') => {
    if (state >= 2 || failing) return
    failing = true
    const error = fail(kind, host, cause)
    clearTimeout(timer)
    emit(Object.assign(new Event('error'), { error, message: error.message }))
    closed(1006, `egress ${kind}: ${host}`, false)
    abort.abort(error)
    raw?.close()
  }
  const limit = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const timer = limit > 0 ? setTimeout(() => {
    const cause = new Error('WebSocket opening handshake timed out')
    failed(cause, 'timeout')
  }, limit) : undefined
  // A backend may resolve a PAC asynchronously. Keep the public constructor synchronous, like every WHATWG transport.
  void Promise.resolve().then(() => backend.webSocket(url, { ...options, signal: abort.signal, onError: error => { nativeError = error } })).then(value => {
    raw = value
    raw.binaryType = binaryType
    raw.addEventListener('error', event => { nativeError = (event as Event & { error?: unknown }).error ?? new Error('WebSocket connection failed') })
    raw.addEventListener('close', event => {
      if (state < 2 && event.code === 1006) failed(event.reason ? new Error(event.reason) : nativeError, state === 1 ? 'connect' : undefined)
      else closed(event.code, event.reason, event.wasClean)
    })
    if (state >= 2) { raw.close(); return }
    const opened = () => { if (state !== 0) return; clearTimeout(timer); state = 1; emit(new Event('open')) }
    raw.addEventListener('open', opened, { once: true })
    raw.addEventListener('message', event => { if (state === 1) emit(new MessageEvent('message', { data: event.data })) })
    if (raw.readyState === 1) opened()
  }, error => { if (!abort.signal.aborted) failed(error) })
  return socket as unknown as WebSocket
}
