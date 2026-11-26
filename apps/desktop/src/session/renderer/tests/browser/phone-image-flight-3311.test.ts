/**
 * #3311 手机看图:从圆角缩略图飞出、往下拖跟手缩小、松手缩回那个圆角气泡。
 * 真 Chromium、真 PhotoSwipe、产品的查看器样式,390 宽;手势用触摸指针事件逐帧喂给 PhotoSwipe。
 */
import PhotoSwipe from 'photoswipe'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { wirePhoneFlight } from '@/components/preview/image-viewer-phone-flight'
import type { ImageViewerItem } from '@/lib/imageViewer'
import { until } from '../../../../../../../tests/support/awaitCondition'
import 'photoswipe/style.css'
import '@/styles/tokens.css'
import '@/components/imagePreview.css'

const RADIUS = 16
let pswp: PhotoSwipe | null = null

afterEach(() => {
  pswp?.destroy()
  pswp = null
  document.querySelectorAll('.gg-image-flight').forEach((el) => el.remove())
  document.body.replaceChildren()
})

function picture(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 600
  canvas.height = 1200
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, 600, 1200)
  gradient.addColorStop(0, '#f2b134')
  gradient.addColorStop(1, '#2a6fdb')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 600, 1200)
  return canvas.toDataURL('image/png')
}

async function openFromBubble(layout: 'clipped' | 'chat' = 'clipped') {
  await page.viewport(390, 844)
  document.body.style.cssText = 'margin:0;background:#0f0f0f'
  const bubble = document.body.appendChild(document.createElement('div'))
  bubble.style.cssText = `position:absolute;left:200px;top:420px;width:120px;height:240px;border-radius:${RADIUS}px;overflow:hidden`
  let holder: HTMLElement = bubble
  if (layout === 'chat') {
    // 真界面的聊天图(#3311 对照时量的):圆角气泡在外圈、带内边距,图套在一个有圆角但不裁切的按钮里,图本身是直角
    bubble.style.cssText = 'position:absolute;left:184px;top:404px;padding:16px 16px 28px;border-radius:20px;background:#262626'
    holder = bubble.appendChild(document.createElement('button'))
    holder.style.cssText = 'display:block;padding:0;border:0;border-radius:8px;width:120px;height:240px;background:none'
  }
  const thumb = holder.appendChild(document.createElement('img'))
  thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
  thumb.src = picture()
  await thumb.decode()
  const items: ImageViewerItem[] = [{ url: thumb.src, alt: '', thumb }]
  pswp = new PhotoSwipe({
    dataSource: [{ src: thumb.src, msrc: thumb.src, width: 600, height: 1200 }],
    index: 0,
    mainClass: 'gg-image-viewer',
    showHideAnimationType: 'none',
    bgOpacity: 1,
    tapAction: 'close',
    imageClickAction: false,
    zoom: false, close: false, counter: false, arrowPrev: false, arrowNext: false,
  })
  wirePhoneFlight(pswp, items, 0)
  pswp.init()
  return { bubble, thumb }
}

const flight = () => document.querySelector<HTMLElement>('.gg-image-flight')
const frame = () => document.querySelector<HTMLElement>('.gg-image-flight__frame')!
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

async function flick(points: { x: number; y: number }[]) {
  const wrap = pswp!.scrollWrap!
  const init = (p: { x: number; y: number }): PointerEventInit => ({ pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true })
  // Let PhotoSwipe consume each pointer move on a real frame, with gesture speed independent of CI frame rate.
  let sampleTime = performance.now()
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => sampleTime)
  try {
    wrap.dispatchEvent(new PointerEvent('pointerdown', init(points[0]!)))
    for (const p of points.slice(1)) {
      sampleTime += 16
      window.dispatchEvent(new PointerEvent('pointermove', init(p)))
      await nextFrame()
    }
    window.dispatchEvent(new PointerEvent('pointerup', init(points[points.length - 1]!)))
  } finally {
    clock.mockRestore()
  }
}

it('opens from the bubble with its rounded corners and hands over to the viewer once it lands', async () => {
  const { bubble } = await openFromBubble()
  expect(flight(), 'the stand-in flies while the viewer is hidden').not.toBeNull()
  expect(pswp!.element!.style.opacity).toBe('0')
  expect(bubble.querySelector('img')!.style.visibility || getComputedStyle(bubble.querySelector('img')!).visibility).toBe('hidden')
  const animations = document.getAnimations()
  animations.forEach((a) => { a.pause(); a.currentTime = 0 })
  const start = frame().getBoundingClientRect()
  expect(Math.round(start.left)).toBe(200)
  expect(Math.round(start.width)).toBe(120)
  expect(Number.parseFloat(getComputedStyle(frame()).borderTopLeftRadius), 'starts with the bubble corners').toBe(RADIUS)
  // 600×1200 放进 390×844:宽顶满 390,高 780,上下各空 32。刚打开时 PhotoSwipe 的 <img> 还在解码,终点不能量它。
  animations.forEach((a) => { a.currentTime = Number(a.effect!.getComputedTiming().duration) - 1 })
  await nextFrame()
  const end = frame().getBoundingClientRect()
  expect([end.left, end.top, end.width, end.height].map(Math.round), 'flies to where the viewer shows the picture').toEqual([0, 32, 390, 780])
  expect(Number.parseFloat(getComputedStyle(frame()).borderTopLeftRadius)).toBeLessThan(0.5)
  animations.forEach((a) => a.play())
  await until('the stand-in lands', () => flight() === null)
  expect(pswp!.element!.style.opacity).toBe('1')
  expect(getComputedStyle(bubble.querySelector('img')!).visibility).toBe('visible')
  const bar = pswp!.element!.querySelector<HTMLElement>('.pswp__top-bar')!
  const fadesIn = bar.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.getKeyframes()[0]?.opacity === '0')
  expect(fadesIn, 'the top bar was not there during the flight: it fades in, it does not pop in').toBe(true)
})

it('a short slow drag shrinks the picture under the finger and springs back to full screen', async () => {
  const { thumb } = await openFromBubble()
  await until('the stand-in lands', () => flight() === null)
  const full = pswp!.currSlide!.content.element!.getBoundingClientRect()
  const path = Array.from({ length: 12 }, (_, i) => ({ x: 195 - i * 2, y: 400 + i * 10 }))
  const wrap = pswp!.scrollWrap!
  const init = (p: { x: number; y: number }): PointerEventInit => ({ pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true })
  wrap.dispatchEvent(new PointerEvent('pointerdown', init(path[0]!)))
  for (const p of path.slice(1)) {
    window.dispatchEvent(new PointerEvent('pointermove', init(p)))
    await nextFrame()
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  expect(flight(), 'dragging shows the stand-in').not.toBeNull()
  const dragged = frame().getBoundingClientRect()
  expect(dragged.width, 'it shrinks while dragged down').toBeLessThan(full.width * 0.95)
  expect(dragged.left + dragged.width / 2, 'and follows the finger sideways').toBeLessThan(full.left + full.width / 2 - 10)
  // 手指从按下到现在走了 (-22, +110):图的中心也正好走这么多。PhotoSwipe 认出方向时会把起点挪到第一步之后,按它算就少 10px。
  expect(dragged.top + dragged.height / 2 - (full.top + full.height / 2), 'stays under the finger from where it went down').toBeCloseTo(110, 0)
  expect(dragged.left + dragged.width / 2 - (full.left + full.width / 2)).toBeCloseTo(-22, 0)
  expect(getComputedStyle(thumb).visibility, 'the bubble it would go back to is left empty, not shown twice').toBe('hidden')
  await new Promise((resolve) => setTimeout(resolve, 150))
  window.dispatchEvent(new PointerEvent('pointerup', init(path[path.length - 1]!)))
  await until('it springs back', () => flight() === null)
  expect(pswp!.isDestroying, 'a short slow drag does not close').toBe(false)
  expect(pswp!.element!.style.opacity).toBe('1')
  expect(getComputedStyle(thumb).visibility).toBe('visible')
})

it('a square picture in a padded chat bubble takes off square, rounds while dragged, and lands square', async () => {
  const { thumb } = await openFromBubble('chat')
  const radiusNow = () => Number.parseFloat(getComputedStyle(frame()).borderTopLeftRadius)
  const opening = document.getAnimations()
  opening.forEach((a) => { a.pause(); a.currentTime = 0 })
  expect(Math.round(frame().getBoundingClientRect().left), 'starts on the picture, not on the bubble').toBe(200)
  expect(radiusNow(), 'the picture itself has square corners: neither the bubble nor the button clips it').toBe(0)
  opening.forEach((a) => a.play())
  await until('the stand-in lands', () => flight() === null)
  const wrap = pswp!.scrollWrap!
  const init = (p: { x: number; y: number }): PointerEventInit => ({ pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true })
  wrap.dispatchEvent(new PointerEvent('pointerdown', init({ x: 195, y: 300 })))
  for (let i = 1; i <= 10; i++) {
    window.dispatchEvent(new PointerEvent('pointermove', init({ x: 195, y: 300 + i * 25 })))
    await nextFrame()
  }
  expect(radiusNow(), 'the dragged picture rounds as it shrinks').toBeGreaterThan(8)
  window.dispatchEvent(new PointerEvent('pointerup', init({ x: 195, y: 550 })))
  await until('the viewer closes', () => pswp!.isDestroying)
  const closing = document.getAnimations()
  closing.forEach((a) => { a.pause(); a.currentTime = Number(a.effect!.getComputedTiming().duration) - 1 })
  await nextFrame()
  expect(radiusNow(), 'and lands on the square picture square').toBeLessThan(0.5)
  closing.forEach((a) => a.play())
  await until('it lands', () => flight() === null)
  expect(getComputedStyle(thumb).visibility).toBe('visible')
  pswp = null
})

it('a fast flick down closes back into the bubble', async () => {
  const { thumb } = await openFromBubble()
  await until('the stand-in lands', () => flight() === null)
  await flick(Array.from({ length: 6 }, (_, i) => ({ x: 195, y: 300 + i * 30 })))
  await until('the viewer closes', () => pswp!.isDestroying)
  expect(flight(), 'the stand-in flies back').not.toBeNull()
  expect(getComputedStyle(thumb).visibility).toBe('hidden')
  await until('it lands in the bubble', () => flight() === null)
  expect(getComputedStyle(thumb).visibility).toBe('visible')
  pswp = null
})
