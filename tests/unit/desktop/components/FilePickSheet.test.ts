// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * API 61 `gugu.files.pick`: the shell's file sheet (on ChatPickSheet) draws the files main listed, newest first, each as a
 * file in a message reads; a search keeps the files whose path has it. One file: a tap answers it. Several: ticked, then
 * the button. 「从电脑添加…」 only when main offers it. Cancelling answers null.
 */

const { FilePickSheet } = await import('../../../../apps/desktop/src/components/chat/FilePickSheet')
const { pickChatFiles } = await import('../../../../apps/desktop/src/components/chat/filePickAsk')
const file = (id: string, path: string, more: Record<string, unknown> = {}) =>
  ({ id, chat: 'c', path, name: path.split('/').pop(), suffix: `.${path.split('.').pop()}`, contentType: 'text/csv', type: 'text', appState: false, size: 2048, updatedAt: '2026-11-20T08:00:00Z', ...more })
const FILES = [file('f-plan', 'plan.md', { contentType: 'text/markdown' }), file('f-csv', '数据/ctDNA.csv')]
const ask = (over: Record<string, unknown> = {}) => pickChatFiles({ files: FILES, multiple: false, upload: false, ...over } as never)

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(FilePickSheet)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const rowIds = () => [...document.body.querySelectorAll('[data-pick-row]')].map((row) => row.getAttribute('data-pick-row'))
const click = (element: Element | null | undefined) => act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const type = async (field: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('FilePickSheet', () => {
  it('one file: rows say name, folder, size and kind; a tap answers it', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ title: '挂一个群文件' }) })
    expect(document.body.textContent).toContain('挂一个群文件')
    expect(rowIds()).toEqual(['f-plan', 'f-csv'])
    const csv = document.body.querySelector('[data-pick-row="f-csv"]')!
    expect(csv.textContent).toContain('ctDNA.csv')
    expect(csv.textContent).toContain('数据')
    expect(csv.textContent).toContain('2.0 KB')
    expect(csv.textContent).toContain('CSV 表格')
    expect(document.body.querySelector('[data-testid="file-pick-sheet-action"]')).toBeNull()
    await click(csv)
    await expect(picked).resolves.toEqual({ ids: ['f-csv'] })
    expect(rowIds()).toEqual([])
  })

  it('a search keeps the files whose path has it', async () => {
    await act(async () => { void ask() })
    await type(document.body.querySelector('input') as HTMLInputElement, '数据')
    expect(rowIds()).toEqual(['f-csv'])
  })

  it('several: ticked, counted, then the App’s button', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ multiple: true, action: '挂上' }) })
    const action = document.body.querySelector<HTMLButtonElement>('[data-testid="file-pick-sheet-action"]')!
    expect(action.textContent).toBe('挂上')
    expect(action.disabled).toBe(true)
    await click(document.body.querySelector('[data-pick-row="f-csv"]'))
    await click(document.body.querySelector('[data-pick-row="f-plan"]'))
    expect(document.body.textContent).toContain('已选 2 个')
    await click(action)
    await expect(picked).resolves.toEqual({ ids: ['f-csv', 'f-plan'] })
  })

  it('「从电脑添加…」 last, only when offered; it answers upload', async () => {
    await act(async () => { void ask() })
    expect(document.body.textContent).not.toContain('从电脑添加')
    await click(document.body.querySelector('button[aria-label="关闭"]'))
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ upload: true }) })
    expect(rowIds().at(-1)).toBe('upload:new')
    await click(document.body.querySelector('[data-pick-row="upload:new"]'))
    await expect(picked).resolves.toEqual({ upload: true })
  })

  it('cancelling answers null; a second ask takes the sheet and the first is answered null', async () => {
    let first: Promise<unknown> = Promise.resolve()
    let second: Promise<unknown> = Promise.resolve()
    await act(async () => { first = ask() })
    await act(async () => { second = ask({ files: [FILES[0]] }) })
    await expect(first).resolves.toBeNull()
    expect(rowIds()).toEqual(['f-plan'])
    await click(document.body.querySelector('button[aria-label="关闭"]'))
    await expect(second).resolves.toBeNull()
  })
})
