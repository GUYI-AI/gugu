import { expect, it } from 'vitest'
import { byteRange, answerBesideDocument } from './preview/chat-folder-preview'
import { createPortDetector, findLoopbackPorts } from './remote-port-detect'

it('accepts HTTP range units case-insensitively', () => {
  expect(byteRange('Bytes=1-3', 10)).toEqual({ start: 1, end: 3 })
})

it('refuses a preview file that ends before its declared size', async () => {
  const found = {
    kind: 'file',
    file: {
      revision: { size_bytes: 4, content_type: 'image/png' },
      read: async () => new Uint8Array()
    }
  } as unknown as Parameters<typeof answerBesideDocument>[0]
  await expect(
    answerBesideDocument(found, {
      path: 'a.png',
      csp: '',
      copy: {
        unavailable: 'unavailable',
        outside: 'outside',
        offline: 'offline',
        palette: { surface: 'white', border: 'gray', text: 'black' }
      }
    })
  ).rejects.toThrow()
})

it('discovers valid one-digit ports', () => {
  expect(findLoopbackPorts('http://localhost:8/')).toEqual([8])
})

it('keeps occurrence order across different server output formats', () => {
  expect(findLoopbackPorts('Serving HTTP on 0.0.0.0 port 8080\nlocalhost:3000/')).toEqual([
    8080, 3000
  ])
})

it('enforces maxPorts within a single push', () => {
  const detector = createPortDetector({ maxPorts: 1 })
  expect(detector.push('localhost:3000/ localhost:4000/')).toEqual([3000])
  expect(detector.push('localhost:5000/')).toEqual([])
})

it('does not retain an incomplete port when tailChars is zero', () => {
  const detector = createPortDetector({ tailChars: 0 })
  expect(detector.push('localhost:3000')).toEqual([])
  expect(detector.push('/')).toEqual([])
})
