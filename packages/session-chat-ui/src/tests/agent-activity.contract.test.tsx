/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { batch } from 'solid-js';
import { textFilePatch } from '@gugu/session-core/lib';
import type { ChatItem } from '../model';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { ChatMessage, TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const peer = 'user:11111111-1111-4111-8111-111111111111';
const me = '22222222-2222-4222-8222-222222222222';
const delivery = (id: string, body = 'Agent update', type = 'agent') => ({ kind: 'message' as const, id, seq: 0, role: 'user' as const, text:
  `<gugu_delivery route="chat" from="d3" from_id="${type === 'agent' ? peer : `user:${me}`}" from_type="${type}" chat="group" chat_kind="group" msg="msg:${id}"><![CDATA[${body}]]></gugu_delivery>` });
const ordinary = (id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage => ({ kind: 'message', id, seq: 0, role, text: id });
const turn = (id: string, items: ChatMessage[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: items as TranscriptTurn['items'] });
const cleanup: Array<() => void> = [];
afterEach(async () => { while (cleanup.length) cleanup.pop()?.(); await cdp().send('Emulation.setEmulatedMedia', { features: [] }); });

async function mount(width: number, records = [turn('in', [delivery('incoming')]), turn('panel', [ordinary('Panel answer')])]) {
  await page.viewport(Math.max(width, 390), 720);
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', agentConversation: true, userGutter: 0 },
    actor: id => id === peer ? { id, type: 'agent', name: 'd3' } : null,
    selfIdentity: () => ({ userId: me, displayName: 'Owner', guguNumber: null }), chatName: () => 'gugu', chatKind: () => 'group' });
  const state = createChatState(context);
  state.transcript.history.seed(records);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:600px`;
  const open = vi.fn();
  const create = () => createChatView({ context, state, parent: host, pinUserMessages: true, commands: { onOpenSender: open } });
  let view = create();
  view.scrollToTop();
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const head = () => host.querySelector<HTMLElement>('[data-agent-activity]');
  const button = () => head()!.querySelector<HTMLButtonElement>('[data-collapse-id]')!;
  await until('activity header mounted', () => !!head());
  await untilStable('initial geometry settled', () => [host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height]);
  return { host, state, head, button, open, get view() { return view; },
    remount: () => { view.dispose(); view = create(); }, scroll: () => host.querySelector<HTMLElement>('[data-chat-scroll]')! };
}

describe('approved A2A activity', () => {
  it('folds the producing activity with its edited file and preview, then restores both on open', async () => {
    const items: ChatItem[] = [delivery('with-file'),
      { kind: 'diff', id: 'owned-edit', status: 'done', patches: [textFilePatch('/work/owned.md', null, 'ready')] },
      { kind: 'mcp-tool-call', id: 'owned-preview', seq: 2, toolCallId: 'owned-preview', title: 'Open preview', server: 'gugu', tool: 'session_open_in_tab',
        status: 'done', rawInput: '{"path":"/work/preview.html"}', outputText: '{"opened":true,"path":"/work/preview.html"}' }];
    const records = [{ ...turn('with-file', []), items: items as TranscriptTurn['items'] }, turn('after-file', [delivery('after-file')])];
    const t = await mount(390, records);
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.host.querySelector('[data-slot="file-change-summary"]')).toBeNull();
    expect(t.host.textContent).not.toContain('preview.html');
    t.button().click();
    await until('owned artifacts open inside the original activity', () => !!t.host.querySelector('[data-slot="file-change-summary"]') && !!t.host.textContent?.includes('preview.html'));
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.host.textContent).toContain('owned.md');
    t.button().click();
    await until('owned artifacts collapse again', () => !t.host.querySelector('[data-slot="file-change-summary"]'));
    expect(t.host.textContent).not.toContain('preview.html');
    expect(t.head()!.textContent).toContain('Received 2 messages');
  });
  it('combines tool-only incoming turns while preserving their original process on open', async () => {
    const records = ['one', 'two'].map((id, seq): TranscriptTurn => ({ ...turn(id, [delivery(`${id}-input`)]), seq, items: [delivery(`${id}-input`),
      { kind: 'mcp-tool-call', id: `${id}-read`, toolCallId: `${id}-read`, seq: 1, title: 'Read history', server: 'gugu', tool: 'message_history', status: 'done', rawInput: '{"chat_id":"group"}', outputText: '[]' }] }));
    const t = await mount(800, records);
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.head()!.textContent).toContain('Received 2 messages');
    const before = t.scroll().scrollHeight;
    t.button().click();
    await until('both original inputs are visible', () => !!t.host.querySelector('[data-user-card="one-input"]') && !!t.host.querySelector('[data-user-card="two-input"]'));
    expect(t.host.querySelectorAll('[data-slot="turn-process"]')).toHaveLength(2);
    t.button().click();
    await untilStable('one activity shrinks back', () => t.scroll().scrollHeight);
    expect(t.scroll().scrollHeight).toBe(before);
  });

  it('never pins an activity header, closed or opened: only the viewer question sticks above its messages', async () => {
    // Owner 2026-11-21: an opened exchange pinned its header under the question and cut the next bubble in half.
    const t = await mount(800, [turn('own', [ordinary('Owner question', 'user'),
      ...Array.from({ length: 12 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45)))]),
      turn('conclusion', [ordinary('Following conclusion')])]);
    const lane = () => t.head()?.closest<HTMLElement>('[data-index]');
    const unpinned = () => !lane() || (getComputedStyle(lane()!.firstElementChild!).position !== 'sticky' && !lane()!.querySelector('[data-chat-pin-backdrop]'));
    for (const open of [false, true]) {
      if (open) { t.button().click(); await untilStable('opened activity settled', () => t.scroll().scrollHeight); }
      for (const scrollTop of [80, 300, 850]) {
        t.scroll().scrollTop = scrollTop;
        await untilStable('scrolled', () => [t.scroll().scrollTop, t.head()?.getBoundingClientRect().top]);
        expect(unpinned(), `activity header pinned (open: ${open}, scrollTop: ${scrollTop})`).toBe(true);
      }
    }
    const own = t.host.querySelector('[data-pin-summary="Owner question"]')!.getBoundingClientRect();
    expect(own.top).toBeCloseTo(t.scroll().getBoundingClientRect().top + 8, 0);
    // Every opened message below the question shows its own first line: nothing else is painted over it.
    const cards = [...t.host.querySelectorAll<HTMLElement>('[data-user-card^="a"]')].filter(card => card.getBoundingClientRect().top >= own.bottom);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      if (r.top + 4 < t.scroll().getBoundingClientRect().bottom) expect(card.contains(document.elementFromPoint(r.left + 20, r.top + 4)), card.dataset.userCard).toBe(true);
    }
  });
  it('keeps the owner pinned while reading ordinary reply content beside a closed activity', async () => {
    const t = await mount(800, [turn('own', [ordinary('Owner question', 'user'), delivery('incoming'),
      ordinary(Array.from({ length: 24 }, (_, i) => `Reply ${i}. `.repeat(45)).join('\n\n'))]),
      turn('next', [ordinary('Next owner question', 'user'), ordinary('Next answer')])]);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    t.host.querySelector<HTMLButtonElement>('[data-expand-user-card]')!.click();
    await untilStable('the full final answer is measured', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('owner reading ordinary reply', () => t.host.querySelector('[data-pin-summary="Owner question"]')?.getBoundingClientRect().top);
    const row = t.host.querySelector<HTMLElement>('[data-pin-summary="Owner question"]');
    expect(row).not.toBeNull();
    expect(row!.getBoundingClientRect().top).toBeCloseTo(t.scroll().getBoundingClientRect().top + 8, 0);
  });
  it('pins the viewer human delivery above its opened activity without treating other human deliveries as the viewer', async () => {
    const own = delivery('Owner message', 'The question I sent from the phone', 'human');
    const t = await mount(800, [turn('own', [own, ...Array.from({ length: 24 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45)))]),
      turn('conclusion', [ordinary('Following conclusion')])]);
    t.button().click();
    await untilStable('human owner activity geometry', () => t.scroll().scrollHeight);
    t.scroll().scrollTop = 850;
    await untilStable('human owner sticky position', () => t.host.querySelector('[data-pin-summary="Owner message"]')?.getBoundingClientRect().top);
    const row = t.host.querySelector<HTMLElement>('[data-pin-summary="Owner message"]');
    expect(row, 'the viewer message must remain mounted while its activity is read').not.toBeNull();
    expect(row!.getBoundingClientRect().top).toBeCloseTo(t.scroll().getBoundingClientRect().top + 8, 0);
  });

  it.each([390, 1280])('defaults closed with centered 44px semantic action and original bubbles on manual open (%i)', async width => {
    const t = await mount(width);
    expect(t.head()!.textContent).toContain('Received 1 message from d3');
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    // Includes title, aria-label, previews and copy controls in the closed subtree.
    expect(t.host.innerHTML).not.toContain('Agent update');
    expect(t.head()!.querySelector('[data-slot=message-copy]')).toBeNull();
    expect(t.host.querySelector('[data-agent-conversation-message="incoming"]')).toBeNull();
    const row = t.head()!.getBoundingClientRect();
    expect(row.height).toBe(44);
    const inline = t.head()!.lastElementChild!.getBoundingClientRect();
    expect(Math.abs((inline.left + inline.right) / 2 - (row.left + row.right) / 2)).toBeLessThan(1);
    t.button().click();
    await until('original agent input visible', () => !!t.host.querySelector('[data-agent-conversation-message="incoming"]'));
    await untilStable('expanded height settled', () => t.scroll().scrollHeight);
    expect(t.button().getAttribute('aria-expanded')).toBe('true');
    expect(t.host.querySelector('[data-user-card="incoming"]')?.textContent).toContain('Agent update');
    t.button().click();
    await until('original bubble removed after shrink', () => !t.host.querySelector('[data-agent-conversation-message="incoming"]'));
    expect(t.host.innerHTML).not.toContain('Agent update');
    expect(t.host.querySelector('[data-agent-conversation-message="Panel answer"]')).not.toBeNull();
  });
  it('navigates an agent name independently of expanding the record', async () => {
    const t = await mount(800);
    t.head()!.querySelector<HTMLButtonElement>('[data-activity-target]')!.click();
    expect(t.open).toHaveBeenCalledWith({ kind: 'sender', userId: peer.slice(5) });
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
  });
  it('opens the owning activity and positions the original message for a search-result jump', async () => {
    const records = Array.from({ length: 18 }, (_, i) => turn(`search${i}`, [delivery(`search${i}`, `Search result ${i}. `.repeat(50))]));
    const t = await mount(390, [...records, turn('answer', [ordinary('Search ending')])]);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    t.view.scrollToItem('search12', { align: 'center' });
    await until('search opens the owning activity', () => t.head()?.dataset.expanded === 'true');
    await untilStable('original search result positioned', () => {
      const row = t.host.querySelector('[data-agent-conversation-message="search12"]');
      return row?.getBoundingClientRect().top;
    });
    const row = t.host.querySelector('[data-agent-conversation-message="search12"]')!.getBoundingClientRect();
    const viewport = t.scroll().getBoundingClientRect();
    expect(row.top).toBeGreaterThanOrEqual(viewport.top);
    expect(row.top).toBeLessThan(viewport.bottom);
  });
  it.each(['answered', 'withdrawn'] as const)('preserves an opened activity when a question is %s in the active and committed transcript', async state => {
    const records = [turn('own', [ordinary('Owner question', 'user')]), turn('report', [delivery('incoming')])];
    const t = await mount(800, records);
    t.button().click();
    await until('report opened', () => t.head()?.dataset.expanded === 'true');
    const receipt = turn('receipt', [{ ...ordinary('receipt', 'user'), text: '<gugu_question_answer>\n'
      + JSON.stringify({ question_id: 'question', state, answers: [{ selected: ['Keep it'] }] }) + '\n</gugu_question_answer>' }]);
    t.state.transcript.activeTurn.set(receipt, 'generating');
    await until('answer status row mounted', () => !!t.host.querySelector('[data-slot="question-answer"]'));
    expect(t.head()?.dataset.expanded).toBe('true');
    expect(t.host.querySelector('[data-user-card="incoming"]')).not.toBeNull();
    batch(() => { t.state.transcript.history.seed([...records, receipt]); t.state.transcript.activeTurn.set(null); });
    await untilStable('answer reconciled', () => t.scroll().scrollHeight);
    expect(t.head()?.dataset.expanded).toBe('true');
    expect(t.host.querySelector('[data-user-card="incoming"]')).not.toBeNull();
    expect(t.host.textContent).not.toContain('<gugu_question_answer>');
  });
  it('preserves an opened activity when another report arrives', async () => {
    const records = [turn('own', [ordinary('Owner question', 'user')]), turn('report', [delivery('incoming')])];
    const t = await mount(800, records);
    t.button().click();
    await until('report opened', () => t.head()?.dataset.expanded === 'true');
    t.state.transcript.history.seed([...records, turn('second', [delivery('second')])]);
    await until('second report visible inside the activity', () => !!t.host.querySelector('[data-user-card="second"]'));
    expect(t.head()?.dataset.expanded).toBe('true');
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
  });
  it('preserves manual reading across remount and collapses old A2A while following a new owner input to bottom', async () => {
    const t = await mount(800, [turn('a', [delivery('incoming', 'Long agent content '.repeat(500))]), turn('p', [ordinary('Panel answer')])]);
    t.button().click();
    await until('body open', () => !!t.host.querySelector('[data-user-card="incoming"]'));
    t.remount();
    await until('expanded state restored', () => t.head()?.getAttribute('data-expanded') === 'true');
    const input = ordinary('Latest own message', 'user');
    t.state.transcript.history.seed([turn('a', [delivery('incoming')]), turn('p', [ordinary('Panel answer')]), turn('own', [input])]);
    await until('new input mounted', () => !!t.host.querySelector('[data-user-card="Latest own message"]'));
    await until('old body closed', () => !t.host.querySelector('[data-user-card="incoming"]'));
    await untilStable('tail follows shrink', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    const card = t.host.querySelector('[data-user-card="Latest own message"]')!.getBoundingClientRect();
    const viewport = t.scroll().getBoundingClientRect();
    expect(card.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
    expect(card.top).toBeGreaterThanOrEqual(viewport.top - 1);
  });
  it('keeps human deliveries and the final panel reply visible between the A2A regions', async () => {
    const t = await mount(800, [turn('t', [delivery('a'), ordinary('First panel text'), ordinary('Second panel text'), delivery('human', 'Human group message', 'human'), delivery('b')])]);
    expect(t.host.querySelector('[data-user-card="First panel text"]')).toBeNull();
    expect(t.host.querySelector('[data-agent-conversation-message="Second panel text"]')).not.toBeNull();
    expect(t.host.querySelector('[data-user-card="human"]')?.textContent).toContain('Human group message');
    expect(t.host.querySelector('[data-user-card="a"]')).toBeNull();
    expect(t.host.querySelector('[data-user-card="b"]')).toBeNull();
  });
  it('updates the same semantic row from pending to received receipt, and stops its light flow when settled', async () => {
    const t = await mount(800, [turn('base', [delivery('incoming')])]);
    const head = t.head();
    const call = { kind: 'mcp-tool-call' as const, id: 'send', toolCallId: 'send', seq: 0, title: 'Send',
      server: 'plugin_gugu-product_gugu', tool: 'message_send', status: 'running' as const,
      rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [peer], text: 'Real reply content' }) };
    const running: TranscriptTurn = { id: 'running', seq: 1, initiator: 'user', items: [call] };
    t.state.transcript.activeTurn.set(running, 'generating');
    await until('live semantic state', () => t.head()?.getAttribute('data-live') === 'true');
    expect(t.head()).toBe(head);
    expect(t.head()!.textContent).toContain('Received 1 message');
    expect(t.host.querySelector('[data-user-card="send:sent:6417511d-8f36-4cbc-8cbb-81ce9f97df73"]')).toBeNull();
    const finished: TranscriptTurn = { ...running, outcome: { kind: 'done' }, items: [{ ...call, status: 'done',
      outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)' }] };
    batch(() => { t.state.transcript.history.seed([turn('base', [delivery('incoming')]), finished]); t.state.transcript.activeTurn.set(null); });
    await until('settled confirmed count', () => !!t.head()?.textContent?.includes('Exchanged 2 messages'));
    expect(t.head()).toBe(head);
    expect(t.head()!.getAttribute('data-live')).toBe('false');
    expect(t.host.innerHTML).not.toContain('Real reply content');
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
  });
  it('folds a group reply to the viewer into the same activity row, with no text and an exact source link', async () => {
    const base: ChatMessage = { ...ordinary('reply:sent:receipt'), text: 'I answered your question.',
      sentAddresses: { target: { kind: 'chat', conversationId: 'group', whisper: false, threadRootId: null },
        recipients: [`user:${me}`], confirmed: true, chatKind: 'group', replyTo: null } };
    const question = ordinary('The owner asks in the panel.', 'user');
    const t = await mount(800, [turn('ask', [question]), turn('reply', [base])]);
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.head()!.textContent).toContain('Replied to you in gugu');
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    expect(t.host.innerHTML).not.toContain('I answered your question.');
    expect(t.host.querySelector(`[data-user-card="${question.id}"]`)?.textContent).toContain(question.text);
    t.head()!.querySelector<HTMLElement>('[data-activity-target="group"]')!.click();
    expect(t.open).toHaveBeenCalledWith({ kind: 'chat', chatId: 'group', messageId: 'receipt' });
    t.button().click();
    await until('the original reply opens inside the activity', () => !!t.host.textContent?.includes('I answered your question.'));
    expect(t.state.transcript.state.committedTurns[1].items).toHaveLength(1);
  });
  it('joins a group reply to the viewer with adjacent agent activity in one row', async () => {
    const base: ChatMessage = { ...ordinary('reply:sent:receipt'), text: 'I answered your question.',
      sentAddresses: { target: { kind: 'chat', conversationId: 'group', whisper: false, threadRootId: null },
        recipients: [`user:${me}`], confirmed: true, chatKind: 'group', replyTo: null } };
    const t = await mount(800, [turn('a', [delivery('incoming')]), turn('reply', [base])]);
    expect(t.host.querySelectorAll('[data-agent-activity]')).toHaveLength(1);
    expect(t.head()!.textContent).toContain('Exchanged 2 messages');
    expect(t.host.innerHTML).not.toContain('I answered your question.');
  });
  it('keeps the owner question and a direct send to the owner visible', async () => {
    const target = { kind: 'chat' as const, conversationId: 'direct', whisper: false, threadRootId: null, recipientUserId: me };
    const sent: ChatMessage = { ...ordinary('owner-send:sent:receipt'), text: 'The owner still sees this answer.', sentTo: target,
      sentAddresses: { target, recipients: [`user:${me}`], confirmed: true, chatKind: 'ai', replyTo: null } };
    const question = ordinary('The owner still sees this question.', 'user');
    const t = await mount(800, [turn('activity', [delivery('incoming')]), turn('owner', [question, sent])]);
    expect(t.host.querySelector(`[data-user-card="${question.id}"]`)?.textContent).toContain(question.text);
    expect(t.host.querySelector(`[data-user-card="${sent.id}"]`)?.textContent).toContain(sent.text);
    expect(t.host.querySelector('[data-agent-activity]')?.textContent ?? '').not.toContain('Replied to you');
    expect(t.state.transcript.state.committedTurns[1].items).toEqual([question, sent]);
  });
  it('keeps an opened group and source identity when older adjacent messages are prepended', async () => {
    const t = await mount(800, [turn('a', [delivery('incoming')]), turn('p', [ordinary('Panel answer')])]);
    const id = t.head()!.dataset.agentActivity;
    t.button().click();
    await until('initial body expanded', () => !!t.host.querySelector('[data-user-card="incoming"]'));
    t.state.transcript.history.seed([turn('old', [delivery('older')]), turn('a', [delivery('incoming')]), turn('p', [ordinary('Panel answer')])]);
    await until('prepended activity visible in same opened region', () => !!t.host.querySelector('[data-user-card="older"]'));
    expect(t.head()!.dataset.agentActivity).toBe(id);
    expect(t.button().getAttribute('aria-expanded')).toBe('true');
  });
  it.each([390, 1280])('keeps the following message where it is when an on-screen exchange is collapsed (%i)', async width => {
    const t = await mount(width, [...Array.from({ length: 4 }, (_, i) => turn(`before${i}`, [ordinary(`Before ${i}. `.repeat(20))])),
      ...Array.from({ length: 3 }, (_, i) => turn(`a${i}`, [delivery(`a${i}`, `Update ${i}.`)])),
      turn('panel', [ordinary('Following conclusion')]), ...Array.from({ length: 15 }, (_, i) => turn(`tail${i}`, [ordinary(`Tail ${i}. `.repeat(20))]))]);
    const top = () => t.head()!.getBoundingClientRect().top - t.scroll().getBoundingClientRect().top;
    t.scroll().scrollTop += top() - 60;
    await untilStable('header placed near the top', () => top());
    t.button().click();
    await until('following conclusion mounted', () => !!t.host.querySelector('[data-user-card="Following conclusion"]'));
    await untilStable('open exchange settled', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    const conclusion = () => t.host.querySelector('[data-user-card="Following conclusion"]')!.getBoundingClientRect().top;
    const before = conclusion();
    expect(before, 'the conclusion is on screen').toBeLessThan(t.scroll().getBoundingClientRect().bottom);
    t.button().click();
    await untilStable('collapse settled', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    expect(Math.abs(conclusion() - before), 'the reader keeps the conclusion where it was').toBeLessThan(2);
  });
  it.each([390, 1280])('keeps the clicked line where it is when the following message is off screen (%i)', async width => {
    // Owner 2026-11-12: opened an exchange in the text, closed it again, and the view went from the 11:51 message to
    // the 11:53 one. With the conclusion below the screen, the line the reader clicked is what stays put.
    const t = await mount(width, [...Array.from({ length: 6 }, (_, i) => turn(`before${i}`, [ordinary(`Before ${i}. `.repeat(20))])),
      ...Array.from({ length: 24 }, (_, i) => turn(`a${i}`, [delivery(`a${i}`, `Update ${i}. `.repeat(45))])),
      turn('panel', [ordinary('Following conclusion')]), ...Array.from({ length: 6 }, (_, i) => turn(`tail${i}`, [ordinary(`Tail ${i}. `.repeat(20))]))]);
    const top = () => t.head()!.getBoundingClientRect().top - t.scroll().getBoundingClientRect().top;
    t.scroll().scrollTop += top() - 200;
    await untilStable('header placed in the text', () => top());
    t.button().click();
    await untilStable('open exchange settled', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    const clicked = top();
    expect(Math.abs(clicked - 200), 'opening keeps the header where it was').toBeLessThan(2);
    expect(t.host.querySelector('[data-user-card="Following conclusion"]'), 'the conclusion is below the screen').toBeNull();
    t.button().click();
    await until('following conclusion mounted', () => !!t.host.querySelector('[data-user-card="Following conclusion"]'));
    await untilStable('collapse settled', () => [t.scroll().scrollTop, t.scroll().scrollHeight]);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    expect(Math.abs(top() - clicked), 'the clicked line stays where it was').toBeLessThan(2);
    const conclusion = t.host.querySelector('[data-user-card="Following conclusion"]')!.getBoundingClientRect();
    expect(conclusion.top, 'the conclusion follows it').toBeGreaterThan(t.head()!.getBoundingClientRect().bottom - 1);
    expect(conclusion.top).toBeLessThan(t.scroll().getBoundingClientRect().bottom);
  });
  it('returns offscreen rows to zero after collapse and a mid-animation history prepend', async () => {
    const records = Array.from({ length: 30 }, (_, i) => turn(`history${i}`, [delivery(`history${i}`, `Long update ${i}. `.repeat(90))]));
    const ending = turn('ending', [ordinary('Visible conclusion')]);
    const t = await mount(800, [...records, ending]);
    const closedHeight = t.scroll().scrollHeight;
    t.button().click();
    await untilStable('all open row heights settled', () => t.scroll().scrollHeight);
    // The reader collapses from the header on screen; nearly all of the opened rows are offscreen below it.
    t.scroll().scrollTop += t.head()!.getBoundingClientRect().top - t.scroll().getBoundingClientRect().top - 40;
    await untilStable('open scrolled position', () => t.scroll().scrollTop);
    t.button().click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    t.state.transcript.history.seed([turn('earlier', [delivery('earlier')]), ...records, ending]);
    await until('group closed', () => t.button().getAttribute('aria-expanded') === 'false');
    await untilStable('offscreen shrink settled', () => t.scroll().scrollHeight);
    expect(t.scroll().scrollHeight).toBe(closedHeight);
    expect(t.host.querySelector('[data-user-card="Visible conclusion"]')).not.toBeNull();
    t.remount();
    await untilStable('remount preserved collapsed geometry', () => t.scroll().scrollHeight);
    expect(t.scroll().scrollHeight).toBe(closedHeight);
  });
  it('removes the opened content at once on manual collapse when reduced motion is enabled', async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const t = await mount(800, [turn('own', [ordinary('Owner question', 'user'), ...Array.from({ length: 24 }, (_, i) => delivery(`a${i}`, `Update ${i}. `.repeat(45))) ]),
      turn('conclusion', [ordinary('Following conclusion. '.repeat(60))]), ...Array.from({ length: 10 }, (_, i) => turn(`tail${i}`, [ordinary(`Tail ${i}. `.repeat(20))]))]);
    t.button().click();
    await untilStable('reduced motion open geometry', () => t.scroll().scrollHeight);
    const top = () => t.head()!.getBoundingClientRect().top;
    const clicked = top();
    t.button().click();
    await until('reduced motion content immediately removed', () => !t.host.querySelector('[data-user-card="a0"]'));
    await untilStable('reduced motion final anchor', () => t.scroll().scrollTop);
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    expect(Math.abs(top() - clicked), 'the clicked header stays where it was').toBeLessThan(2);
  });
  it('keeps closed activity lanes at header height while idle prefetch measures the surrounding history', async () => {
    const records = Array.from({ length: 18 }, (_, i) => turn(`t${i}`, [delivery(`hidden${i}`, 'A hidden long agent update. '.repeat(100)), ordinary(`Panel reply ${i}`)]));
    const t = await mount(800, records);
    const oversized: number[] = [];
    for (let i = 0; i < 30; i++) {
      t.scroll().scrollTop = i * 80;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      for (const header of t.host.querySelectorAll<HTMLElement>('[data-agent-activity][data-expanded="false"]')) {
        const height = Number.parseFloat(header.closest<HTMLElement>('[data-index]')!.style.height);
        if (height > 70) oversized.push(height);
      }
    }
    expect(oversized, 'prefetch must not restore reserved height for an invisible folded message').toEqual([]);
  });
});
