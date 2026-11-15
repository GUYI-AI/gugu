// The phone's download of a chat document read its text with the platform's fetch called as a method of a plain object,
// which a browser refuses ("Failed to execute 'fetch' on 'Window': Illegal invocation"). It is called on its own now.
import { expect, it } from 'vitest'
import { readDocumentText } from '../../../apps/desktop/src/session/shared/extensions/chat-folder-text'

it('reads a document with a fetch that refuses to be called as another object\'s method', async () => {
  function browserFetch(this: unknown, url: string) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    return Promise.resolve(new Response(JSON.stringify({ text: `read ${url}` })))
  }
  const text = await readDocumentText({ filesUrl: () => 'https://files.test', fetch: browserFetch as unknown as typeof fetch }, 'token', 'item-1')
  expect(text).toBe('read https://files.test/item-1')
})
