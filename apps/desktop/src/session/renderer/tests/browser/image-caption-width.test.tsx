import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels'
import { buildBubbleStyle } from '@/components/chat/messageBubbleStyle'
import '@/components/chat/mediaAttachmentBubble.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

const caption = '个人项目的话题我也没展开，怎么全量展示了，而且我觉得也现在应该是话题 点击全部，跳到话题详情页，然后他的 section 头下面是个输入框'

it.each([[280, 280], [80, 200]])('a %ipx picture with a long caption sets the bubble width; the caption wraps under it', async (image, expected) => {
  await page.viewport(1400, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1100px'
  await renderWithAppProviders(harness, <div data-message-bubble-column style={{ containerType: 'inline-size', display: 'flex', flexDirection: 'column' }}>
    <div data-bubble style={buildBubbleStyle(true, false, false)}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
        <div className="max-w-full chat-image-with-caption"><div data-image style={{ width: image, height: 150 }} /><p data-caption>{caption}</p></div>
      </div>
    </div>
  </div>)
  const box = harness.container.querySelector<HTMLElement>('.chat-image-with-caption')!
  const text = harness.container.querySelector<HTMLElement>('[data-caption]')!
  expect(Math.round(box.getBoundingClientRect().width)).toBe(expected)
  expect(text.getBoundingClientRect().width).toBeLessThanOrEqual(expected)
  expect(text.getClientRects().length, 'one block').toBe(1)
  expect(text.getBoundingClientRect().height, 'wraps to several lines').toBeGreaterThan(50)
})

it('pictures sent together with a long caption: the tiles set the bubble width, the caption wraps under them', async () => {
  const { MessageBubble } = await import('@/components/chat/MessageBubble')
  const { MessageAlbumContext } = await import('@/components/chat/MessageAlbumContext')
  const picture = (id: string, said?: string) => message({ id, is_mine: true, content_type: 'attachment', file_blob_id: `blob-${id}`, content: attachmentEnvelope(`${id}.png`, 1234, 'image/png', said) })
  const first = picture('first'), last = picture('last', caption)
  await page.viewport(1400, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1100px'
  await renderWithAppProviders(harness, <MessageAlbumContext.Provider value={new Map([[first.id, [first, last]]])}>
    <MessageBubble msg={first} isGroup compactMobile={false} onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} />
  </MessageAlbumContext.Provider>)
  await until('the album rendered', () => !!harness.container.querySelector('[data-testid="message-album-tiles"]'))
  const tiles = harness.container.querySelector<HTMLElement>('[data-testid="message-album-tiles"]')!.getBoundingClientRect().width
  const album = harness.container.querySelector<HTMLElement>('[data-message-album]')!.getBoundingClientRect().width
  expect(Math.round(tiles)).toBe(280)
  expect(Math.round(album), 'the caption does not widen the album past its tiles').toBe(280)
})
