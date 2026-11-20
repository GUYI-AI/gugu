/**
 * #3322 HTML 附件预览的画布底色:页面没声明深色,就像浏览器一样是白底;声明了深色才是深底。
 * 真 Chromium、真预览组件(不透明沙箱 + 注入脚本),读页面空白处的真实像素。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame'
import { previewDocumentHtml } from '@shared/preview/preview-link-script'
import { readThemePreference, writeThemePreference } from '@renderer/lib/theme/host-theme'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

const PLAIN = '<p style="color:#222;margin:8px">dark text, no background, no color-scheme</p>'
const DARK = '<meta name="color-scheme" content="dark"><p style="margin:8px">this page opts into dark</p>'

let previousTheme: ReturnType<typeof readThemePreference> = 'light'
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup())
  writeThemePreference(previousTheme)
})

async function pixelUnderPage(theme: 'light' | 'dark', body: string): Promise<[number, number, number]> {
  await page.viewport(600, 400)
  previousTheme = readThemePreference()
  writeThemePreference(theme)
  const container = document.body.appendChild(document.createElement('div'))
  // 预览外面那一圈是 App 自己的底色,和真界面一样
  container.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;display:flex;background:var(--bg-primary)'
  const root = createRoot(container)
  const url = URL.createObjectURL(new Blob([previewDocumentHtml(body)], { type: 'text/html' }))
  cleanups.push(() => { act(() => root.unmount()); container.remove(); URL.revokeObjectURL(url) })
  const register = async (): Promise<HtmlPreviewRegistration> => ({ ok: true, url, update: async () => url, release: () => {} })
  await act(async () => root.render(<HtmlPreviewFrame fileName="page.html" rawContent={body} register={register} onLink={() => {}} />))
  await until('the preview page has loaded', () => {
    const frame = container.querySelector('iframe')
    return !!frame && frame.src === url && getComputedStyle(frame).visibility === 'visible'
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  // save: false 时直接回 base64 字符串
  const shot: unknown = await page.screenshot({ base64: true, save: false })
  const base64 = typeof shot === 'string' ? shot : (shot as { base64: string }).base64
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  const scale = bitmap.width / innerWidth
  // 页面下半部分空白处:只有画布底色
  const [r, g, b] = context.getImageData(Math.round(200 * scale), Math.round(250 * scale), 1, 1).data
  return [r!, g!, b!]
}

it('a page that declares nothing gets a white canvas in the dark theme, not the app background', async () => {
  const [r, g, b] = await pixelUnderPage('dark', PLAIN)
  expect([r, g, b], 'dark text on near-black was the bug').toEqual([255, 255, 255])
})

it('a page that declares nothing gets a white canvas in the light theme too', async () => {
  expect(await pixelUnderPage('light', PLAIN)).toEqual([255, 255, 255])
})

it.each(['dark', 'light'] as const)('a page that opts into dark keeps a dark canvas (%s theme)', async (theme) => {
  const [r, g, b] = await pixelUnderPage(theme, DARK)
  expect(Math.max(r, g, b), 'dark canvas').toBeLessThan(40)
})
