import type PhotoSwipe from 'photoswipe'
import { DUR_MED_MS, DUR_SLOW_MS, EASE } from '@/styles/motion'
import type { ImageViewerItem } from '@/lib/imageViewer'

// @@@phone-image-flight (#3311) — 手机上看图的「开、关、下拉」三段由这里画,不用 PhotoSwipe 自带的缩放动画:
// 它从裁切过的缩略图起飞时,是用两层错开的容器拼出裁切框(opener 的 _cropContainer1/2),圆角加不上去,
// 一起飞就是直角、落回去那一下圆角突然出现;它的下拉关闭也只会上下平移、不缩小。
// 这里画一张替身图:一个带圆角、overflow:hidden 的框,里面的图 object-fit: cover —— 框的形状从缩略图的
// 形状变到大图的形状,裁切和圆角都是框自己的,天然连续。替身在飞时 PhotoSwipe 的根整个透明(手势照收),
// 落地后换回 PhotoSwipe 本体。电脑上不走这里。

export interface Box { x: number; y: number; width: number; height: number }

/** 往下拖过屏高的五分之一,或松手时往下的速度超过这个数(CSS px/s),就关。 */
const CLOSE_DISTANCE_RATIO = 1 / 5
const CLOSE_SPEED = 500
/** 往下拖半屏时缩到 0.7,拖满一屏缩到 0.4。 */
const DRAG_SHRINK = 0.6
const SPEED_WINDOW_MS = 100
const DRAG_MAX_RADIUS = 25
const DRAG_RADIUS_PER_SHRINK = 70

export function dragScale(dy: number, viewportHeight: number): number {
  return 1 - Math.min(1, Math.max(0, dy / viewportHeight)) * DRAG_SHRINK
}

/** 背景跟着拖动距离变透,往上往下都算;拖到四成屏高时剩一成五。 */
export function dragBackdrop(dy: number, viewportHeight: number): number {
  return 1 - Math.min(1, Math.abs(dy) / (viewportHeight * 0.4)) * 0.85
}

export function shouldCloseOnRelease(dy: number, speedY: number, viewportHeight: number): boolean {
  return dy > 0 && (dy > viewportHeight * CLOSE_DISTANCE_RATIO || speedY > CLOSE_SPEED)
}

/** 按图的宽高比,放进 area 里能放下的最大框,居中。 */
export function containBox(aspect: number, area: Box): Box {
  if (!(aspect > 0) || area.width <= 0 || area.height <= 0) return area
  const width = Math.min(area.width, area.height * aspect)
  const height = width / aspect
  return { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height }
}

/**
 * 缩略图看上去的圆角:图自己的圆角;没有就往上找真把它裁出圆角的那层 —— 那层得裁(overflow 不是 visible)
 * 而且角和图的角对齐。聊天气泡的圆角在外圈、和图之间隔着内边距,图本身是直角(#3311 真界面对照量到的),不算。
 */
export function thumbRadius(thumb: Element | null | undefined): number {
  if (!thumb) return 0
  const own = Number.parseFloat(getComputedStyle(thumb).borderTopLeftRadius)
  if (own > 0) return own
  const corner = thumb.getBoundingClientRect()
  let el = thumb.parentElement
  for (let depth = 0; el && depth < 4; depth += 1, el = el.parentElement) {
    const style = getComputedStyle(el)
    const radius = Number.parseFloat(style.borderTopLeftRadius)
    if (!(radius > 0)) continue
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible' || (style.clipPath && style.clipPath !== 'none')
    const box = el.getBoundingClientRect()
    if (clips && Math.abs(box.left - corner.left) <= 1 && Math.abs(box.top - corner.top) <= 1) return radius
  }
  return 0
}

/** 往下拖时替身的圆角:越小越圆,最多 25px(原型:拖到缩成六成五左右圆到顶)。和缩略图自己的圆角无关,缩回去时再变成它的。 */
export function dragRadius(scale: number): number {
  return Math.min(DRAG_MAX_RADIUS, Math.max(0, 1 - scale) * DRAG_RADIUS_PER_SHRINK)
}

/** 原型(#3311 设计稿)三段用的弹簧:刚度 k、阻尼 c,质量 1,从静止出发。 */
export interface SpringSpec { k: number; c: number }
export const OPEN_SPRING: SpringSpec = { k: 240, c: 29 }
export const CLOSE_SPRING: SpringSpec = { k: 300, c: 31 }
export const SPRING_BACK: SpringSpec = { k: 320, c: 30 }

const FRAME_S = 1 / 60
const SUBSTEPS = 8
const curves = new Map<string, { duration: number; easing: string }>()

/**
 * 弹簧从 0 走到 1 的曲线,写成 CSS linear() 缓动:和原型一样每帧分 8 小步积分,
 * 离终点不到 0.002、速度也小到 0.06 就算停;每帧取一个点,时长 = 帧数。
 */
export function springCurve({ k, c }: SpringSpec): { duration: number; easing: string } {
  const key = `${k}/${c}`
  const cached = curves.get(key)
  if (cached) return cached
  const points = [0]
  let x = 0, v = 0
  const h = FRAME_S / SUBSTEPS
  while (points.length < 180 && !(Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.06)) {
    for (let i = 0; i < SUBSTEPS; i += 1) {
      v += (-k * (x - 1) - c * v) * h
      x += v * h
    }
    points.push(x)
  }
  points[points.length - 1] = 1
  const curve = { duration: Math.round((points.length - 1) * FRAME_S * 1000), easing: `linear(${points.map((p) => Number(p.toFixed(4))).join(', ')})` }
  curves.set(key, curve)
  return curve
}

function springTiming(spring: SpringSpec): KeyframeAnimationOptions {
  const supported = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timing-function', 'linear(0, 1)')
  if (!supported) return { duration: DUR_SLOW_MS, easing: `cubic-bezier(${EASE.join(', ')})` }
  return springCurve(spring)
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 这次打开走不走替身:手机、没要求减少动效、点开的那张在页面上有位置。 */
export function usesPhoneFlight(mobile: boolean, item: ImageViewerItem | undefined): boolean {
  return mobile && !reducedMotion() && Boolean(item?.thumb || item?.thumbRect)
}

const boxOf = (rect: DOMRect | Box): Box => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })

function thumbImage(item: ImageViewerItem | undefined): HTMLImageElement | null {
  const thumb = item?.thumb
  if (thumb instanceof HTMLImageElement) return thumb
  return thumb?.querySelector('img') ?? null
}

function visibleBox(el: Element): Box | null {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return null
  return boxOf(rect)
}

interface Flight {
  layer: HTMLDivElement
  backdrop: HTMLDivElement
  frame: HTMLDivElement
  image: HTMLImageElement
  running: Animation[]
}

function place(flight: Flight, box: Box, radius: number, backdrop: number): void {
  const { style } = flight.frame
  style.left = `${box.x}px`
  style.top = `${box.y}px`
  style.width = `${box.width}px`
  style.height = `${box.height}px`
  style.borderRadius = `${radius}px`
  flight.backdrop.style.opacity = String(backdrop)
}

/** 替身此刻在哪儿、多圆、背景多深 —— 读的是正在跑的动画的当前值。 */
function current(flight: Flight): { box: Box; radius: number; backdrop: number } {
  const frame = getComputedStyle(flight.frame)
  return {
    box: boxOf(flight.frame.getBoundingClientRect()),
    radius: Number.parseFloat(frame.borderTopLeftRadius) || 0,
    backdrop: Number.parseFloat(getComputedStyle(flight.backdrop).opacity) || 0,
  }
}

function stop(flight: Flight): void {
  const now = current(flight)
  flight.running.forEach((animation) => animation.cancel())
  flight.running = []
  place(flight, now.box, now.radius, now.backdrop)
}

function fly(flight: Flight, to: Box, radius: number, backdrop: number, spring: SpringSpec, done: () => void): void {
  const from = current(flight)
  stop(flight)
  place(flight, to, radius, backdrop)
  if (typeof flight.frame.animate !== 'function') { done(); return }
  const timing = springTiming(spring)
  const frame = flight.frame.animate([
    { left: `${from.box.x}px`, top: `${from.box.y}px`, width: `${from.box.width}px`, height: `${from.box.height}px`, borderRadius: `${from.radius}px` },
    { left: `${to.x}px`, top: `${to.y}px`, width: `${to.width}px`, height: `${to.height}px`, borderRadius: `${radius}px` },
  ], timing)
  const fade = flight.backdrop.animate([{ opacity: from.backdrop }, { opacity: backdrop }], timing)
  flight.running = [frame, fade]
  frame.onfinish = () => {
    if (!flight.running.includes(frame)) return
    flight.running = []
    done()
  }
}

/**
 * 接在 PhotoSwipe 上(init 之前):打开时从缩略图飞到大图,关时从大图此刻的位置缩回当前这张的缩略图,
 * 往下拖时跟手缩小。调用方已把 showHideAnimationType 设成 'none'(PhotoSwipe 自己瞬开瞬关)。
 */
export function wirePhoneFlight(pswp: PhotoSwipe, items: readonly ImageViewerItem[], openedIndex: number): void {
  let flight: Flight | null = null
  let hidden: HTMLElement | null = null
  let drag: { base: Box; dy: number; samples: { t: number; y: number }[] } | null = null
  let closing = false

  const thumbOf = (index: number) => items[index]?.thumb ?? null
  const thumbBox = (index: number): Box | null => {
    const thumb = thumbOf(index)
    if (thumb?.isConnected) return visibleBox(thumb)
    const rect = index === openedIndex ? items[index]?.thumbRect : undefined
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
  }
  const hideThumb = (index: number) => {
    showThumb()
    const thumb = thumbOf(index)
    if (thumb?.isConnected) { thumb.style.visibility = 'hidden'; hidden = thumb }
  }
  const showThumb = () => {
    if (hidden) hidden.style.visibility = ''
    hidden = null
  }
  const showViewer = (shown: boolean) => {
    if (pswp.element) pswp.element.style.opacity = shown ? '1' : '0'
  }
  // 替身落地换回本体时,图和背景原样接上;顶栏(返回、编辑、复制、下载)飞的时候不在,淡入,别一下蹦出来。
  const landInViewer = () => {
    showViewer(true)
    pswp.element?.querySelectorAll<HTMLElement>('.pswp__hide-on-close').forEach((bar) => {
      bar.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: DUR_MED_MS, easing: `cubic-bezier(${EASE.join(', ')})` })
    })
    showThumb()
    land()
  }
  // 大图此刻在屏上的框,按幻灯片的几何算(位移 + 尺寸 × 缩放),不量 <img>:刚打开那一刻它还在解码、
  // 没挂进页面,量出来是 0×0,替身就飞向左上角。
  const contentBox = (): Box | null => {
    const slide = pswp.currSlide
    const holder = slide?.holderElement
    if (!slide || !holder) return null
    const origin = holder.getBoundingClientRect()
    const rect = { x: origin.x + slide.pan.x, y: origin.y + slide.pan.y, width: slide.width * slide.currZoomLevel, height: slide.height * slide.currZoomLevel }
    if (!(rect.width > 0 && rect.height > 0)) return null
    // 尺寸还不知道的那张按视口占位:按缩略图的比例放进去,别把替身拉成整屏。
    const img = thumbImage(items[pswp.currIndex])
    const sized = (pswp.currSlide?.data as { sizeKnown?: boolean } | undefined)?.sizeKnown !== false
    return !sized && img?.naturalWidth ? containBox(img.naturalWidth / img.naturalHeight, rect) : rect
  }
  const sourceFor = (index: number): string => {
    const shown = pswp.currSlide?.content.element
    if (shown instanceof HTMLImageElement && shown.complete && shown.naturalWidth > 0) return shown.currentSrc || shown.src
    const img = thumbImage(items[index])
    return img?.currentSrc || img?.src || items[index]?.url || ''
  }
  const open = (box: Box, radius: number, backdrop: number, src: string): Flight => {
    if (flight) { flight.image.src = src; stop(flight); return flight }
    const layer = document.createElement('div')
    layer.className = 'gg-image-flight'
    layer.setAttribute('aria-hidden', 'true')
    const backdropEl = layer.appendChild(document.createElement('div'))
    backdropEl.className = 'gg-image-flight__backdrop'
    const frame = layer.appendChild(document.createElement('div'))
    frame.className = 'gg-image-flight__frame'
    const image = frame.appendChild(document.createElement('img'))
    image.alt = ''
    image.decoding = 'sync'
    image.src = src
    const objectPosition = thumbImage(items[pswp.currIndex]) ? getComputedStyle(thumbImage(items[pswp.currIndex])!).objectPosition : ''
    if (objectPosition) image.style.objectPosition = objectPosition
    document.body.append(layer)
    flight = { layer, backdrop: backdropEl, frame, image, running: [] }
    place(flight, box, radius, backdrop)
    return flight
  }
  const land = () => {
    flight?.running.forEach((animation) => animation.cancel())
    flight?.layer.remove()
    flight = null
  }

  // 打开:PhotoSwipe 已瞬开(根不透明、图在最终位置),先藏起它,替身从缩略图飞过去,落地再换回本体。
  pswp.on('openingAnimationEnd', () => {
    const from = thumbBox(pswp.currIndex)
    const to = contentBox()
    if (!from || !to) return
    showViewer(false)
    hideThumb(pswp.currIndex)
    const img = thumbImage(items[pswp.currIndex])
    const src = img?.currentSrc || img?.src || items[pswp.currIndex]?.url || ''
    fly(open(from, thumbRadius(img ?? thumbOf(pswp.currIndex)), 0, src), to, 0, 1, OPEN_SPRING, () => {
      if (!closing) landInViewer()
    })
  })

  // 手指按下的点,和 PhotoSwipe 的 p1 同一坐标系。PhotoSwipe 认出拖动方向(先走 10px)时会把 startP1 挪到当下,
  // 拿它算位移,图就一直比手指慢那一截;从按下那一点算,图才贴着手指。
  let down: { x: number; y: number } | null = null
  pswp.on('pointerDown', ({ originalEvent }) => {
    if (!originalEvent.isPrimary) return
    down = { x: originalEvent.pageX - pswp.offset.x, y: originalEvent.pageY - pswp.offset.y }
  })

  // 下拉:接管 PhotoSwipe 的竖拖(它只上下平移),替身跟着手指走、越往下越小、背景越透。
  pswp.on('verticalDrag', (event) => {
    event.preventDefault()
    const { p1 } = pswp.gestures
    const startP1 = down ?? pswp.gestures.startP1
    const height = pswp.viewportSize.y || innerHeight
    if (!drag) {
      const base = contentBox()
      if (!base) return
      drag = { base, dy: 0, samples: [] }
      open(base, 0, 1, sourceFor(pswp.currIndex))
      showViewer(false)
      // 背景一变透,对话里那张原图就露出来了:先空着它的位置,图正要回那儿去。
      hideThumb(pswp.currIndex)
    }
    if (!flight) return
    const dx = p1.x - startP1.x
    const dy = p1.y - startP1.y
    const scale = dragScale(dy, height)
    const { base } = drag
    const width = base.width * scale, boxHeight = base.height * scale
    const radius = dragRadius(scale)
    place(flight, { x: base.x + base.width / 2 + dx - width / 2, y: base.y + base.height / 2 + dy - boxHeight / 2, width, height: boxHeight }, radius, dragBackdrop(dy, height))
    const now = performance.now()
    drag.dy = dy
    drag.samples.push({ t: now, y: p1.y })
    while (drag.samples.length > 2 && drag.samples[0]!.t < now - SPEED_WINDOW_MS) drag.samples.shift()
  })
  pswp.on('pointerUp', () => {
    if (!drag) return
    const { base, dy, samples } = drag
    drag = null
    const first = samples[0], last = samples[samples.length - 1]
    const seconds = first && last ? (last.t - first.t) / 1000 : 0
    const speedY = seconds > 0.008 ? (last!.y - first!.y) / seconds : 0
    if (shouldCloseOnRelease(dy, speedY, pswp.viewportSize.y || innerHeight)) {
      // PhotoSwipe 还在处理这次抬手,等它处理完再关。
      setTimeout(() => pswp.close(), 0)
      return
    }
    if (!flight) return
    fly(flight, base, 0, 1, SPRING_BACK, landInViewer)
  })

  // 关:点一下、返回键、左上箭头、下拉松手都走这里。缩回当前这张的缩略图;它不在屏上就让 PhotoSwipe 淡出。
  pswp.on('close', () => {
    const to = thumbBox(pswp.currIndex)
    if (!to) {
      land()
      showThumb()
      showViewer(true)
      pswp.options.showHideAnimationType = 'fade'
      return
    }
    closing = true
    const from = flight ? current(flight).box : contentBox()
    if (!from) { land(); showThumb(); return }
    const backdrop = flight ? current(flight).backdrop : 1
    const radius = thumbRadius(thumbImage(items[pswp.currIndex]) ?? thumbOf(pswp.currIndex))
    const target = open(from, flight ? current(flight).radius : 0, backdrop, sourceFor(pswp.currIndex))
    hideThumb(pswp.currIndex)
    fly(target, to, radius, 0, CLOSE_SPRING, () => { showThumb(); land() })
  })
  pswp.on('destroy', () => {
    if (closing) return
    showThumb()
    land()
  })
}
