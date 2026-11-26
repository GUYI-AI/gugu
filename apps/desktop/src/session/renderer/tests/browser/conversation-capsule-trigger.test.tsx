// The conversation capsule on a chat's card (第 16 版 #8): the name ChatBlockHead draws into the chat's title slot is the
// card's trigger, and it fills the whole capsule — a short name in the capsule's minimum width still opens the card from
// the capsule's empty sides, ❌ only from the text.
import { useEffect, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { commandRegistry } from '@renderer/lib/commands/registry';
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

// Owner 11-26: 「点 Search chat history 到 prompt 最终出现」 — the search panel mounts with its input focused in the same
// render the card closes in, and the closing card handed focus back to the name: the prompt was up but typing went nowhere.
function CapsuleWithSearch() {
  const [searching, setSearching] = useState(false);
  useEffect(() => commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', hideFromPalette: true, execute: () => setSearching(true) }] }), []);
  return <><Capsule />{searching ? <input autoFocus data-probe="search-input" onKeyDown={(event) => { if (event.key === 'Escape') setSearching(false); }} /> : null}</>;
}

it('search from the card: the search input keeps focus; Escape still returns it to the name', async () => {
  harness = createReactHarness();
  await renderWithAppProviders(harness, <CapsuleWithSearch />);
  const trigger = document.querySelector<HTMLElement>('[data-testid="conversation-capsule"]')!;
  await userEvent.click(trigger);
  await userEvent.click(await waitFor(() => document.querySelector<HTMLElement>('[data-testid="conversation-card-search"]')));
  const input = await waitFor(() => document.querySelector<HTMLElement>('[data-probe="search-input"]'));
  await waitFor(() => !document.querySelector('[data-testid="conversation-card"]'));
  await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
  expect(document.activeElement, 'the search input keeps the focus it took').toBe(input);

  await userEvent.keyboard('{Escape}');
  await userEvent.click(trigger);
  await waitFor(() => document.querySelector('[data-testid="conversation-card"]'));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => !document.querySelector('[data-testid="conversation-card"]'));
  await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
  expect(document.activeElement, 'Escape returns focus to the name').toBe(trigger);
});

async function waitFor<T>(read: () => T, timeout = 3000): Promise<NonNullable<T>> {
  const until = performance.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value as NonNullable<T>;
    if (performance.now() > until) throw new Error('timed out');
    await new Promise((frame) => requestAnimationFrame(frame));
  }
}
