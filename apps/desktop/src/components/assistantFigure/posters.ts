/**
 * 助理小鸟的静态定格:给助理的 still 头像和只能放图的地方(lib/identityFace.ts 的 faceImageUrl)。会动的那只是 AssistantFigure。
 * 定格由同一个引擎画一帧静止的样子(runtime.still):颜色、休息表情、装扮都和会动的那只对得上。按形象缓存,同一个形象
 * 整个会话只画一次。
 * 第一次要的那一刻还没画好:先给打包的同色定格(12 张 = 12 种身体颜色各一张,平静脸、不戴装扮,由本体定格按
 * engine/identity.ts 同一套换色离线烘出;存储里那 12 张给老客户端的也是它们),画好后通知订阅者换上。
 */
import { useSyncExternalStore } from 'react'
import { rendererLogger } from '@/lib/log'
import { wornOf, type AssistantLook } from './look'
import { bodyTint } from './engine/identity'
import { wearKey } from './engine/outfitCatalog'
import { runtime } from './engine/runtime'
import face00 from './assets/faces/assistant-poster-00.webp'
import face01 from './assets/faces/assistant-poster-01.webp'
import face02 from './assets/faces/assistant-poster-02.webp'
import face03 from './assets/faces/assistant-poster-03.webp'
import face04 from './assets/faces/assistant-poster-04.webp'
import face05 from './assets/faces/assistant-poster-05.webp'
import face06 from './assets/faces/assistant-poster-06.webp'
import face07 from './assets/faces/assistant-poster-07.webp'
import face08 from './assets/faces/assistant-poster-08.webp'
import face09 from './assets/faces/assistant-poster-09.webp'
import face10 from './assets/faces/assistant-poster-10.webp'
import face11 from './assets/faces/assistant-poster-11.webp'

const FACES = [face00, face01, face02, face03, face04, face05, face06, face07, face08, face09, face10, face11]

/** 定格的边长(像素):和打包的那 12 张一样大,全身取景 */
const POSTER_PX = 256

const log = rendererLogger('assistant-figure/posters')

const drawn = new Map<string, Promise<string>>()
/** 画失败了的定格:界面每次渲染都会来要,所以默认不重画;能自己重试的调用方(通知)带 retryFailed 再要一次 */
const failed = new Set<string>()
const ready = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

/** 定格按「颜色 | 表情 | 实际穿的那一身」缓存:缺省装扮为空,同一形象共用定格 */
const keyOf = (look: AssistantLook) => `${look.color}|${look.rest}|${wearKey(wornOf(look))}`

/** 这个形象的定格画好了的那张;还没画就开始画。画失败记一条,这次会话里不再重画(❌ 每次渲染都起一轮等待);只有带 retryFailed 的调用方(通知里的成员头像)才会把失败的再画一次 */
export function settledAssistantPoster(look: AssistantLook, { retryFailed = false }: { retryFailed?: boolean } = {}): Promise<string> {
  const key = keyOf(look)
  if (retryFailed && failed.delete(key)) drawn.delete(key)
  let p = drawn.get(key)
  if (!p) {
    p = runtime.still({ tint: bodyTint(look.color), rest: look.rest, wear: wornOf(look) }, POSTER_PX)
    drawn.set(key, p)
    p.then(
      (url) => {
        ready.set(key, url)
        version++
        for (const fn of listeners) fn()
      },
      (err: unknown) => {
        failed.add(key)
        log.error({ key, error: String(err) }, 'drawing agent look poster failed')
      }
    )
  }
  return p
}

/** 这个形象的定格(调用方先定好身体颜色、表情与保存的装扮)。还没画好 = 打包的同色那张 */
export function assistantPoster(look: AssistantLook): string {
  const hit = ready.get(keyOf(look))
  if (hit) return hit
  void settledAssistantPoster(look).catch(() => {}) // 失败已在里面记过
  return FACES[look.color]
}

/** 有定格画好了就通知(只能放图、又不在 React 里的地方据此重读) */
export function subscribeAssistantPosters(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** React 里读定格:画好了自动换上 */
export function useAssistantPostersVersion(): number {
  return useSyncExternalStore(subscribeAssistantPosters, () => version, () => version)
}

export function useAssistantPoster(look: AssistantLook): string {
  useAssistantPostersVersion()
  return assistantPoster(look)
}
