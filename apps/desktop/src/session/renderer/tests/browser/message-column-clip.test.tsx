/**
 * A laid-out message row's body is content-visibility:auto (tokens.css), which clips paint and hit testing to the body box
 * even while the row is on screen. What the bubble draws beside its column must still paint and take clicks: the read
 * receipt ring left of an own bubble that fills the column (desktop, and the phone's 44px tap area), and the bubble tail.
 * Real MessageBubble in a real MessageRow; judged by hit testing (clipped paint is not hit).
 */
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { MemberProfileCardModel } from '@/components/MemberProfileCard';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/styles/tokens.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));

const { MessageBubble } = await import('@/components/chat/MessageBubble');
const { MessageRow } = await import('@/components/chat/MessageRow');

const lin: MemberProfileCardModel = { id: 'sender-1', displayName: '林知夏', avatar: null, email: null, type: 'human', role: 'member' } as MemberProfileCardModel;
// Long enough that the bubble fills its column, so whatever is anchored beside it lies outside the column.
const TEXT = 'A message long enough to fill the whole message column of this row, edge to edge. '.repeat(4);

let harness: ReturnType<typeof createReactHarness>;
let seq = 0;
beforeAll(async () => { await i18n.changeLanguage('zh-CN'); await page.viewport(900, 700) });
afterEach(() => harness?.cleanup());

async function renderRow(isMine: boolean, compactMobile: boolean) {
  harness = createReactHarness();
  harness.container.style.width = compactMobile ? '390px' : '720px';
  const id = `clip-${++seq}`;
  await renderWithAppProviders(harness, createNode(MessageRow, { messageId: id },
    createNode(MessageBubble, {
      msg: message({ id, sender_user_id: 'sender-1', created_at: '2026-11-15T09:41:00.000Z', content: TEXT, is_mine: isMine }),
      onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
      compactMobile, isGroup: true, memberProfile: lin, memberProfiles: { 'sender-1': lin },
      readReceiptRead: 0, readReceiptTotal: 2,
    })));
  await until('row laid out', () => !!harness.container.querySelector('[data-bubble-tail]') && harness.container.querySelector('[role=listitem]')!.hasAttribute('data-laid-out'));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const column = harness.container.querySelector<HTMLElement>('[data-message-bubble-column]')!
  expect(getComputedStyle(harness.container.querySelector<HTMLElement>('[data-row-body]')!).contentVisibility).toBe('auto')
  return { column: column.getBoundingClientRect(), bubble: harness.container.querySelector<HTMLElement>('[data-bubble-tail]')! }
}

const hit = (x: number, y: number) => document.elementFromPoint(x, y)

describe('a laid-out message row does not clip what the bubble draws beside its column', () => {
  for (const compactMobile of [false, true]) {
    it(`${compactMobile ? 'phone' : 'desktop'}: the read receipt left of an own bubble that fills the column paints and takes clicks`, async () => {
      const { column } = await renderRow(true, compactMobile);
      const receipt = harness.container.querySelector<HTMLElement>('[data-testid="message-read-receipt"]')!
      const box = receipt.getBoundingClientRect()
      expect(box.left, 'receipt lies outside the column').toBeLessThan(column.left - 4)
      expect(receipt.contains(hit(box.left + box.width / 2, box.top + box.height / 2))).toBe(true)
    });

    for (const isMine of [true, false]) {
      it(`${compactMobile ? 'phone' : 'desktop'}: the tail of ${isMine ? 'an own' : 'a received'} bubble paints`, async () => {
        const { bubble } = await renderRow(isMine, compactMobile);
        // The tail is pointer-events:none; let it take the hit test so a clipped tail shows as a miss.
        const probe = document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '[data-bubble-tail]::before { pointer-events: auto !important; }' }))
        try {
          const box = bubble.getBoundingClientRect()
          // 6px out from the bubble's edge, 2px above its bottom: inside the tail's 8px, past a 4px clip margin.
          expect(hit(isMine ? box.right + 6 : box.left - 6, box.bottom - 2)).toBe(bubble)
        } finally { probe.remove() }
      });
    }
  }
});
