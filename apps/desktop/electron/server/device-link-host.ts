/**
 * #6264 远程 SSH 的咕咕 server 上,「设备连接」的账号进程这一侧:添加这台机器的那台桌面经 SSH 来的那条线。
 *
 * 照 VS Code Remote-SSH:本机客户端 ↔ SSH ↔ server 的本机套接字。桌面经 SSH 跑 `gugu-server link`,
 * 它把标准输入输出接到这个账号的 attach 套接字上;这里把每条连接当成一条「设备 RPC 频道」来答:
 * 与咕咕云转来的设备 RPC **同一张处理表**(设置、资源库、已安排、文件、审阅、会话列表与时间线、投递、导入……),
 * 同一种信封、同一种推送。所以两条通道的行为只有一份,差别只在「字节走哪」。
 * 连外面那层也一样:每条消息都是 Realtime 广播的形状 `{ type: 'broadcast', event: 'broadcast', payload: 信封 }`
 * (两端的解析都先剥这一层,平铺的信封会把请求自己的 payload 当成信封读 —— 见 core/cloud/payload.ts)。
 *
 * 信任边界是操作系统用户(能经 SSH 以这个系统用户登上来的人,本来就读得到这个账号的一切文件):
 * 请求信封上的 user_id 一律换成这个账号自己,❌ 信对端报的。
 */
import {
  createDeviceRpcRequestHandler,
  type DeviceRpcHandlers,
} from '@gugu/core/cloud/deviceRpcResponder'
import { createDeviceRpcReplyEnvelope, parseDeviceRpcRequest } from '@gugu/core/cloud/deviceRpcProtocol'
import { encodeDataFrame } from '../session/main/core/pty/attach/attach-protocol'
import { SESSION_HOST_FRAME_EVENT, SESSION_HOST_RPC } from '@shared/lib/ipc/session-host-device-frames'

// 终端的输入(桌面 → 机器:`{t:'invoke', channel:'pty.sendInput'}`)与输出(机器 → 桌面:`{t:'event', channel:'pty:data.<id>'}`)。
// 帧是 JSON 文本,t 与 channel 都在 args / data 之前(session-host-client、frame-host 的写法),只看开头一截就够,
// 大帧拆成几片时看第一片;不依赖键的先后。
const HEAD_CHARS = 256
const TERMINAL_OUTPUT_CHANNEL = /"channel":"pty:data[."]/

/** 一片是不是终端的输入或输出(拆开的大帧只看第一片)。 */
function isTerminalPiece(piece: unknown): boolean {
  if (!piece || typeof piece !== 'object') return false
  const { f, p } = piece as { f?: unknown; p?: unknown }
  if (typeof f !== 'string' || (p !== undefined && p !== 0)) return false
  const head = f.slice(0, HEAD_CHARS)
  if (head.includes('"t":"invoke"')) return head.includes('"channel":"pty.sendInput"')
  if (head.includes('"t":"event"')) return TERMINAL_OUTPUT_CHANNEL.test(head)
  return false
}

/**
 * 设备连接上的这一条信封算不算「在用」(云电脑的管家据此判闲置,见 core/cloud/remoteTunnel.ts 的 noteTunnelActivity):
 * 白名单,只认会话页宿主帧里的终端输入与输出。❌ 心跳、状态轮询(taskhost.call)、打开窗口、订阅、别的调用、机器推来的变动
 * —— 那些是「光连着」(总控 2026-10-15 定)。请求(帧在 payload.frames)与推送(帧在 frames)两种形状都认。纯函数。
 */
export function isTunnelUse(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== 'object') return false
  const e = envelope as { type?: unknown; payload?: unknown; frames?: unknown }
  if (e.type !== SESSION_HOST_RPC.frame && e.type !== SESSION_HOST_FRAME_EVENT) return false
  const frames = Array.isArray(e.frames) ? e.frames : (e.payload as { frames?: unknown } | null | undefined)?.frames
  return Array.isArray(frames) && frames.some(isTerminalPiece)
}

export type DeviceLinkSession = { handle(message: unknown): void; dispose(): void }

/**
 * A request answered with a stream of bytes (only a device link can carry them: `D` frames beside its messages). It names its
 * stream in `payload.stream`; each `write` resolves when the line takes more. Its reply follows its last piece on the same
 * ordered line, so a reader holding the reply holds every byte. `<type>.cancel` with `{ stream }` (or the link closing) stops it.
 *
 * @@@stream-credit - draining the socket is not enough: ssh's channel window and the TCP buffers between here and the reader
 * hold megabytes, and every message on the link waits behind what is queued. So the reader acknowledges what it holds
 * (`<type>.ack` `{ stream, received, window }`) and no more than `window` bytes past it are ever on their way: the line
 * stays full (the reader sizes it at about two seconds of its rate) while a message waits about that long at most.
 */
/** Before the reader has said how fast it takes them: about one second of a fast line. */
export const STREAM_FIRST_WINDOW_BYTES = 1024 * 1024
export const STREAM_MIN_WINDOW_BYTES = 256 * 1024
export const STREAM_MAX_WINDOW_BYTES = 32 * 1024 * 1024

export type DeviceLinkStream = (payload: unknown, context: {
  userId: string
  write(offset: number, bytes: Uint8Array): Promise<void>
  signal: AbortSignal
}) => Promise<unknown>

export function createDeviceLinkHost(options: {
  /** 这个账号自己的用户 id(server 的账号进程由 GUGU_SERVER_ACCOUNT 指定)。 */
  userId: () => string | null
  /** 每条连接一份处理器,与云端频道「按频道建、按频道拆」同一条规矩(处理器可能握着会话订阅)。 */
  createHandlers: () => { handlers: DeviceRpcHandlers; dispose: () => void }
  warn?: (message: string) => void
  /** 这条连接上有人在用(终端的输入与输出,见 isTunnelUse;应答不算,它跟着请求来):心跳据此报「隧道最近一次有流量」。 */
  onActivity?: () => void
  streams?: Record<string, DeviceLinkStream>
}): (send: (message: unknown) => void, sendData: (frame: Buffer) => Promise<void>) => DeviceLinkSession {
  return (send, sendData) => {
    const userId = options.userId()
    if (!userId) throw new Error('这个账号还没登录,不接设备连接')
    const host = options.createHandlers()
    const handleRequest = createDeviceRpcRequestHandler({
      warn: options.warn,
      handlers: host.handlers,
    })
    let open = true
    const running = new Map<string, { controller: AbortController; acked: number; window: number; wake: (() => void) | null }>()
    const stream = (type: string, handler: DeviceLinkStream, request: { request_id: string; payload: unknown }) => {
      const id = (request.payload as { stream?: unknown } | null)?.stream
      if (typeof id !== 'string' || !id || running.has(id)) {
        return publish(createDeviceRpcReplyEnvelope(type, request.request_id, { error: { code: 'invalid_request', message: 'a stream needs its own id' } }))
      }
      const controller = new AbortController()
      const start = (request.payload as { offset?: unknown }).offset
      const state = { controller, acked: typeof start === 'number' ? start : 0, window: STREAM_FIRST_WINDOW_BYTES, wake: null as (() => void) | null }
      running.set(id, state)
      controller.signal.addEventListener('abort', () => state.wake?.(), { once: true })
      const write = async (offset: number, bytes: Uint8Array) => {
        while (open && !controller.signal.aborted && offset + bytes.byteLength - state.acked > state.window) {
          await new Promise<void>((resolve) => { state.wake = resolve })
          state.wake = null
        }
        if (!open || controller.signal.aborted) throw new Error('stream stopped')
        await sendData(encodeDataFrame(id, offset, bytes))
      }
      void handler(request.payload, { userId, write, signal: controller.signal }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error: { code: controller.signal.aborted ? 'cancelled' : 'stream_failed', message: error instanceof Error ? error.message : String(error) } }),
      ).then((response) => {
        running.delete(id)
        publish(createDeviceRpcReplyEnvelope(type, request.request_id, response))
      })
    }
    const publish = (payload: unknown) => {
      if (open) send(asBroadcast(payload))
    }
    const publishEvent = (payload: unknown) => {
      if (open && isTunnelUse(payload)) options.onActivity?.()
      publish(payload)
    }
    return {
      handle(message) {
        if (!open || !message || typeof message !== 'object') return
        const inner = (message as { payload?: unknown }).payload
        if (!inner || typeof inner !== 'object') return
        if (isTunnelUse(inner)) options.onActivity?.()
        const request = parseDeviceRpcRequest(inner)
        if (request && options.streams) {
          const handler = options.streams[request.type]
          if (handler) return stream(request.type, handler, request)
          const [base, verb] = [request.type.slice(0, request.type.lastIndexOf('.')), request.type.slice(request.type.lastIndexOf('.') + 1)]
          if ((verb === 'cancel' || verb === 'ack') && options.streams[base]) {
            const payload = (request.payload ?? {}) as { stream?: unknown; received?: unknown; window?: unknown }
            const state = typeof payload.stream === 'string' ? running.get(payload.stream) : undefined
            if (!state) return
            if (verb === 'cancel') return void state.controller.abort()
            if (typeof payload.received === 'number' && payload.received > state.acked) state.acked = payload.received
            if (typeof payload.window === 'number' && payload.window >= STREAM_MIN_WINDOW_BYTES && payload.window <= STREAM_MAX_WINDOW_BYTES) state.window = payload.window
            state.wake?.()
            return
          }
        }
        void handleRequest(asBroadcast({ ...(inner as Record<string, unknown>), user_id: userId }), publish, publishEvent)
      },
      dispose() {
        if (!open) return
        open = false
        for (const state of running.values()) state.controller.abort()
        running.clear()
        host.dispose()
      },
    }
  }
}

/** 与 Realtime 广播同一个外壳(见文件抬头)。 */
export function asBroadcast(payload: unknown): { type: 'broadcast'; event: 'broadcast'; payload: unknown } {
  return { type: 'broadcast', event: 'broadcast', payload }
}
