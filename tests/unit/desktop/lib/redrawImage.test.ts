import { afterEach, describe, expect, it, vi } from 'vitest'
import { redrawImage } from '../../../../apps/desktop/src/lib/redrawImage'

// #3432 A picture drawn for an OS notification is drawn while the app may be in the background: the phone's WebView is
// then hidden, no frame is rendered, and `img.decode()` waits for a frame — it never settles — while `load` still
// fires. The face stays a pending promise (memberFace caches it), so the notification goes out as "picture unavailable"
// and the late refresh never has anything to carry.

type Outcome = 'loads' | 'fails'

/** An `Image` as a hidden document behaves: `load`/`error` fire, `decode()` never settles. */
function stubHiddenDocument(outcome: Outcome) {
  const drawn: unknown[][] = []
  class HiddenImage {
    naturalWidth = 400
    naturalHeight = 300
    crossOrigin: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      setTimeout(() => (outcome === 'loads' ? this.onload?.() : this.onerror?.()), 0)
    }
    decode() { return new Promise<void>(() => undefined) }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...args: unknown[]) => { drawn.push(args) } }),
    toDataURL: (type: string) => `data:${type};base64,AAAA`,
  }
  vi.stubGlobal('Image', HiddenImage)
  vi.stubGlobal('document', { createElement: () => canvas })
  return drawn
}

const options = { size: 128, fit: 'cover', type: 'image/webp', quality: 0.8 } as const
// The suite sets no per-test timeout (vitest.config.ts testTimeout: 0): a draw that never settles must fail here, not hang.
const within = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 200))])

describe('redrawImage in a hidden document', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('draws a picture that has loaded although decode() never settles', async () => {
    const drawn = stubHiddenDocument('loads')
    const face = await within(redrawImage('https://storage.example/avatars/a.png', options))
    expect(face).toBe('data:image/webp;base64,AAAA')
    // The middle square of a 400x300 picture, drawn at the face size.
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.slice(1)).toEqual([50, 0, 300, 300, 0, 0, 128, 128])
  })

  it('is null when the picture does not load', async () => {
    stubHiddenDocument('fails')
    expect(await within(redrawImage('https://storage.example/avatars/missing.png', options))).toBeNull()
  })
})
