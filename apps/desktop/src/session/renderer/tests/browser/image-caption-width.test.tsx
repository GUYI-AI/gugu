import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

const words = '名片盘点完了（图：左边点人，右边点 agent，上浅下深）。两种其实是同一个组件，只是里面按 agent 分了一套排布：宽度、头像尺寸、「发消息」的样式都不一样。'
  + '悄悄话、查找、分享在人那边是带字的描边按钮，在 agent 这边是灰底的图标方块，而设计规范里明确禁止这种方块。'
const picture = (id: string, said?: string) => message({ id, content_type: 'attachment', file_blob_id: `blob-${id}`, content: attachmentEnvelope(`${id}.png`, 1234, 'image/png', said) })

/** One message (an album when `album` holds several rows) drawn in a 1100px message column; returns the bubble and its words. */
async function draw(msg: MessageItem, album?: MessageItem[]) {
  const { MessageBubble } = await import('@/components/chat/MessageBubble')
  const { MessageAlbumContext } = await import('@/components/chat/MessageAlbumContext')
  await page.viewport(1400, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1100px'
  await renderWithAppProviders(harness, <MessageAlbumContext.Provider value={new Map(album ? [[msg.id, album]] : [])}>
    <MessageBubble msg={msg} isGroup compactMobile={false} onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} />
  </MessageAlbumContext.Provider>)
  await until('the message rendered', () => !!harness.container.querySelector('[data-testid="message-bubble-action-target"]'))
  const width = (selector: string) => Math.round(harness.container.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? NaN)
  const text = [...harness.container.querySelectorAll<HTMLElement>('p')].find(p => p.textContent?.includes('名片盘点'))
  const result = { bubble: width('[data-testid="message-bubble-action-target"]'), text: text ? Math.round(text.getBoundingClientRect().width) : 0 }
  harness.cleanup()
  return result
}

it('words under pictures are as wide as the same words alone: the pictures do not narrow them', async () => {
  const alone = await draw(message({ id: 'words', content: words }))
  expect(alone.text, 'long words fill the message width').toBeGreaterThan(600)
  const underOne = await draw(picture('one', words))
  expect(underOne.text).toBeGreaterThanOrEqual(alone.text)
  const first = picture('first'), last = picture('last', words)
  const underAlbum = await draw(first, [first, last])
  expect(underAlbum.text).toBeGreaterThanOrEqual(alone.text)
})

it('a picture without words keeps the bubble at the picture width', async () => {
  const one = await draw(picture('bare'))
  const first = picture('first'), last = picture('last')
  const album = await draw(first, [first, last])
  expect(one.bubble, 'pending picture is 200px plus the 12px padding on each side').toBeLessThanOrEqual(200 + 24)
  expect(album.bubble, 'album tiles are 280px plus padding').toBeLessThanOrEqual(280 + 24)
})
