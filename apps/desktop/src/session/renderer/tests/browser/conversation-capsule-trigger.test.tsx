// The conversation capsule on a chat's card (第 16 版 #8): the name ChatBlockHead draws into the chat's title slot is the
// card's trigger, and it fills the whole capsule — a short name in the capsule's minimum width still opens the card from
// the capsule's empty sides, ❌ only from the text.
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import type { ChatItem } from '@gugu/core/shared/types/chat';
import { ChatBlockHead } from '@/components/chat/ChatBlockHead';
import { ChatTabChip } from '@renderer/features/chats/chat-tabs/chat-panes';
import { ChatWorkspaceTabContext } from '@renderer/features/tabs/chat-workspace-context';
import '@/styles/tokens.css';
import '@renderer/index.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());

const chat = { id: 'chat-1', kind: 'group', name: 'w' } as unknown as ChatItem;

function Capsule() {
  // The chat's title slot (ChatPartSlot part="title"): the element the chat's head portals its name into.
  const [title, setTitle] = useState<HTMLElement | null>(null);
  return (
    <ChatWorkspaceTabContext.Provider value={{ role: 'capsule', layout: null as never }}>
      <div style={{ position: 'relative', width: 600, height: 48 }}>
        <ChatTabChip tab={null as never} host={null as never} focused label="w" menu={undefined}
          labelSlot={<span ref={setTitle} className="flex min-w-0 flex-1" data-chat-part="title" />} />
      </div>
      <ChatBlockHead host={{ title }} chat={chat} name="w" avatar={null} isAgent={false} />
    </ChatWorkspaceTabContext.Provider>
  );
}

it('a one-letter name: the trigger covers the whole capsule, so its empty sides open the card too', async () => {
  harness = createReactHarness();
  await harness.render(<Capsule />);
  const capsule = document.querySelector<HTMLElement>('[data-chat-workspace-title]')!.getBoundingClientRect();
  const trigger = document.querySelector<HTMLElement>('[data-testid="conversation-capsule"]')!.getBoundingClientRect();
  expect(capsule.width).toBeGreaterThanOrEqual(68);
  expect([trigger.left, trigger.top, trigger.width, trigger.height]).toEqual([capsule.left, capsule.top, capsule.width, capsule.height]);
  // A point near the capsule's left end, well clear of the name, hits the trigger.
  const hit = document.elementFromPoint(capsule.left + 4, capsule.top + capsule.height / 2);
  expect(hit?.closest('[data-testid="conversation-capsule"]')).not.toBeNull();
});
