/**
 * 默认主题的对比度地板(WCAG 2.x):每个写字 / 画图标的颜色 token,在它会落上去的每个面上都要过线。
 *
 * 为什么用真 Chromium:token 大多是 color-mix / 半透明 / 跨块引用,只有浏览器算出来的值才是用户看到的。
 * 半透明的前景先合成到面上再量(canvas),和眼睛看到的一样。
 *
 * 地板:
 *   4.5  正文、次级字、占位符、链接 / 在跑的蓝字、红 / 黄 / 绿状态字(1.4.3)
 *   3    装饰色(图标、状态点)、焦点环(1.4.11)
 * 面:page、bg、card、popover、muted(输入底、分段底)、sidebar。
 */
import { afterEach, describe, expect, it } from 'vitest'
import '@/styles/tokens.css'

const SURFACES = ['--page', '--bg', '--card', '--popover', '--muted', '--sidebar']

const FLOORS: Array<[string, number]> = [
  ['--fg', 4.5],
  ['--muted-fg', 4.5],
  ['--color-text-placeholder', 4.5],
  ['--live-fg', 4.5],
  ['--text-link', 4.5],
  ['--danger-fg', 4.5],
  ['--warn-fg', 4.5],
  ['--ok-fg', 4.5],
  ['--faint-fg', 3],
  ['--focus-ring', 3],
]

const previousTheme = document.documentElement.getAttribute('data-theme')
afterEach(() => {
  if (previousTheme === null) document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', previousTheme)
})

/** 先铺页面底(面可能半透明),再铺面,再铺字;读出两次像素算对比度。 */
function contrast(surface: string, foreground: string) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const paint = (color: string) => {
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data.slice()
  }
  paint(resolve('--page'))
  const background = paint(resolve(surface))
  const text = paint(resolve(foreground))
  const luminance = (pixel: Uint8ClampedArray) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const channel = pixel[index] / 255
    return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  }, 0)
  const a = luminance(background), b = luminance(text)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function resolve(name: string) {
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  expect(color, `${name} must resolve`).not.toBe('')
  return color
}

describe.each(['dark', 'light'])('default %s theme meets the contrast floors', (theme) => {
  it.each(FLOORS)('%s ≥ %s on every surface', (token, floor) => {
    document.documentElement.setAttribute('data-theme', theme)
    for (const surface of SURFACES) {
      expect(contrast(surface, token), `${token} on ${surface}`).toBeGreaterThanOrEqual(floor)
    }
  })
})
