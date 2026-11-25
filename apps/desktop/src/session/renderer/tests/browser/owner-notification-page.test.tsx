/**
 * An agent sends its owner an .html file with a page size from the session the owner reads (an owner notification, kept
 * in the session's journal). The task timeline draws that page in place, in a sandboxed frame at the size it was sent
 * with, through the chat's own MessageBody; without a size it is the file card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatContext, createChatState } from '@gugu/session-chat-ui';
import type { ChatContext, ChatState, TranscriptTurn } from '@gugu/session-chat-ui';
import '@renderer/index.css';
import '@/styles/tokens.css';
import { createNode, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The session's file is read through the host; here its bytes are a 420px tall page.
const pageUrl = URL.createObjectURL(new Blob(['<div style="height:420px">Builds this week</div>'], { type: 'text/html' }));
vi.mock('@/lib/attachmentBytes', async (original) => ({
  ...(await original<object>()),
  useAttachmentObjectUrl: (source: { kind: string }, variant: string, enabled: boolean) => {
    if (source.kind !== 'session-file' || variant !== 'full') throw new Error(`a page in a task reads its whole session file, not ${source.kind}/${variant}`);
    return { ...(enabled ? { status: 'ready', objectUrl: pageUrl } : { status: 'loading' }), retry: () => undefined };
  },
}));

const { SentMessageBodyHost } = await import('@/components/chat/SentMessageBodyHost');
const { ChatTranscript } = await import('@renderer/lib/chat/chat-transcript');

const REQUEST = '22222222-2222-4222-8222-222222222222';
/** The journal turn `commitOwnerNotification` writes for a file sent to the owner, with the size it was sent with. */
const notification = (size: { width: number; height: number } | undefined): TranscriptTurn => ({
  id: `owner-notify:${REQUEST}`, seq: 1, initiator: 'agent', trigger: { kind: 'agent' }, startedAt: 1, endedAt: 1, outcome: { kind: 'done' },
  items: [{ kind: 'message', id: `owner-notify:${REQUEST}:message:${REQUEST}`, seq: 0, role: 'assistant', text: 'weekly.html', at: 1,
    ownerNotification: { requestId: REQUEST, requestHash: 'h', files: [{ path: '/task/weekly.html', name: 'weekly.html', mimeType: 'text/html',
      sizeBytes: 1204, sha256: 'a'.repeat(64), ...size }] } }],
} as TranscriptTurn);

let app: ReturnType<typeof createReactHarness>;
let state: ChatState;
let context: ChatContext;

beforeEach(() => {
  context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72 });
  state = createChatState(context);
  app = createReactHarness();
  app.container.className = 'gugu-skin emlight';
  app.container.style.cssText = 'position:relative;width:900px;height:700px';
});
afterEach(() => {
  app.cleanup();
  state.dispose();
  context.dispose();
});

/** The session's timeline as its page draws it (ChatTranscript), and the app's host for what the agent sent. */
async function renderTimeline(turn: TranscriptTurn) {
  state.transcript.history.seed([turn]);
  await renderWithAppProviders(app, createNode('div', { style: { height: 700 } },
    createNode(SentMessageBodyHost),
    createNode(ChatTranscript, { context, state, style: { height: 700 }, commands: { conversationAgentSession: () => 'session' } })));
}

const pageBox = () => app.container.querySelector<HTMLElement>('[data-html-page]');

describe('a page sent to the owner of the session they read', () => {
  it('is drawn in place at the size it was sent with', async () => {
    await renderTimeline(notification({ width: 400, height: 300 }));
    await until('the page box rendered', () => pageBox() !== null);
    await until('the page reported its height', () => (pageBox()!.getBoundingClientRect().height) > 400);
    const frame = pageBox()!.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.src.startsWith('blob:')).toBe(true);
    // The sent 400px, narrowed to the transcript's bubble if it is narrower (as an image's box is).
    const width = pageBox()!.getBoundingClientRect().width;
    expect(width).toBeLessThanOrEqual(400);
    expect(width).toBeGreaterThan(300);
    expect(app.container.querySelector('.gg-hfile')).toBeNull();
  });

  it('is its file card when sent without a size', async () => {
    await renderTimeline(notification(undefined));
    await until('the file card rendered', () => app.container.querySelector('.gg-hfile') !== null);
    expect(pageBox()).toBeNull();
  });
});
