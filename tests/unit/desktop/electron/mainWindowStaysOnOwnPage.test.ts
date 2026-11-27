// 主窗只在应用自己的页面里换页(aux-window.ts 的 isOwnPage,主窗 will-navigate 用它):拖进来的 blob: 图(和应用同源)、
// 文件、外链都换不了主帧。
import { describe, expect, it, vi } from 'vitest'

const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => {}))
vi.mock('electron', () => ({ BrowserWindow: class {}, shell: { openExternal } }))

const { isOwnPage, openOutside } = await import('../../../../apps/desktop/electron/aux-window')

describe('主窗能换到的页面', () => {
  it('应用自己的页面：同一协议、同一源(打包后的 gugu-app://、开发时的 vite)', () => {
    expect(isOwnPage('gugu-app://app/', 'gugu-app://app/index.html')).toBe(true)
    expect(isOwnPage('gugu-app://app/index.html#/chat/x', 'gugu-app://app/index.html')).toBe(true)
    expect(isOwnPage('http://localhost:5173/', 'http://localhost:5173/index.html')).toBe(true)
  })

  it('别的一律不是:同源的 blob:、文件、外链、别的 host / 端口、坏地址', () => {
    expect(isOwnPage('blob:gugu-app://app/0e1f', 'gugu-app://app/index.html')).toBe(false)
    expect(isOwnPage('file:///Users/x/a.svg', 'gugu-app://app/index.html')).toBe(false)
    expect(isOwnPage('https://example.com/', 'gugu-app://app/index.html')).toBe(false)
    expect(isOwnPage('http://localhost:5174/', 'http://localhost:5173/index.html')).toBe(false)
    expect(isOwnPage('gugu-app://other/', 'gugu-app://app/index.html')).toBe(false)
    expect(isOwnPage('not a url', 'gugu-app://app/index.html')).toBe(false)
  })
})

describe('从这些窗口出去的链接', () => {
  it('只有网页、邮件、电话交给系统;别的 scheme 一律不开', () => {
    for (const url of ['https://example.com/', 'http://localhost:3000/', 'mailto:a@example.com', 'tel:+123']) openOutside(url)
    for (const url of ['file:///etc/passwd', 'x-apple.systempreferences:com.apple.preference.security', 'javascript:alert(1)', 'vscode://x']) openOutside(url)
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual(['https://example.com/', 'http://localhost:3000/', 'mailto:a@example.com', 'tel:+123'])
  })
})
