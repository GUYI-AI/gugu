import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { kv, sessionTurns } from '@main/db/schema';
import { eq } from 'drizzle-orm';
import { personalConversationPreview } from '@gugu/session-core/session-record/personal-conversation';
import { activityPreviewSources, activityPreviewLabel } from '@gugu/session-chat-ui/activity-preview';
import { defaultChatTranslator as translate } from '../../../../../../../packages/session-chat-ui/src/localization';
import { foldedPreviewTurn, previewAgent, previewBody } from '../../../../../../../tests/support/foldedPreviewFixture';

const mock = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mock.db) throw new Error('Missing fixture'); return mock.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { events } from '@main/lib/events';
import { nativeConversationActivity, noteNativeConversationActivity } from './session-conversation-activity';
import { nativeConversationListActivity, openNativeConversationPreviews } from './session-conversation-live';

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture(); mock.db = fixture.db;
  vi.mocked(events.emit).mockClear();
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','Fixture','/fixture'); INSERT INTO sessions(id,project_id) VALUES('s','p')");
});
afterEach(() => { openNativeConversationPreviews(async () => {}).dispose(); fixture.close(); mock.db = undefined; });
const context = { translate, chatName: () => 'Test group', chatKind: () => 'group' as const,
  actor: (id: string) => ({ id, type: id === previewAgent ? 'agent' as const : 'human' as const, name: id === previewAgent ? 'Worker' : 'Owner' }) };
const label = (preview: ReturnType<typeof nativeConversationListActivity>) => preview ? activityPreviewLabel(preview.activity, context) : null;

it.each(['group', 'agent', 'owner'] as const)('preserves %s fold ownership through durable activity and a module reload', async kind => {
  noteNativeConversationActivity('s', foldedPreviewTurn(kind), fixture.db);
  const first = nativeConversationActivity('s')!;
  expect(first).toMatchObject({ text: previewBody, activityVersion: 1, at: new Date(2000).toISOString() });
  expect(label(first) === null).toBe(kind === 'owner');
  expect(JSON.stringify(first.activity)).not.toContain('someone@example.com');
  vi.resetModules();
  expect((await import('./session-conversation-activity')).nativeConversationActivity('s')).toEqual(first);
});

it.each(['group', 'owner'] as const)('rebuilds a legacy %s cached preview from its recorded turn without changing its clock', kind => {
  const turn = foldedPreviewTurn(kind);
  fixture.db.insert(sessionTurns).values({ id: 'row', sessionId: 's', seq: 0, turnId: turn.id, data: JSON.stringify(turn) }).run();
  const cached = JSON.stringify({ text: previewBody, at: new Date(2000).toISOString(), turnSeq: 0 });
  fixture.db.insert(kv).values({ key: 'native-conversation-activity:s', value: cached, updatedAt: 9000 }).run();
  const result = nativeConversationActivity('s')!;
  expect(result).toMatchObject({ text: previewBody, activityVersion: 1, at: new Date(2000).toISOString() });
  expect(label(result) === null).toBe(kind === 'owner');
  expect(fixture.db.select().from(kv).where(eq(kv.key, 'native-conversation-activity:s')).get()?.value).toBe(cached);
});

it('does not render an unclassified legacy cache when its original turn is unavailable', () => {
  fixture.db.insert(kv).values({ key: 'native-conversation-activity:s', value: JSON.stringify({ text: previewBody, at: new Date(2000).toISOString(), turnSeq: 0 }), updatedAt: 9000 }).run();
  expect(nativeConversationActivity('s')).toBeNull();
});

it('publishes provenance changes even when live text and time stay the same, then retains it through worker handoff', async () => {
  const bridge = openNativeConversationPreviews(async () => {});
  try {
    const owner = personalConversationPreview(foldedPreviewTurn('owner'), activityPreviewSources)!;
    const group = personalConversationPreview(foldedPreviewTurn(), activityPreviewSources)!;
    await bridge.update({ sessionId: 's', preview: owner });
    expect(label(nativeConversationListActivity('s'))).toBeNull();
    const count = vi.mocked(events.emit).mock.calls.length;
    await bridge.update({ sessionId: 's', preview: group });
    expect(label(nativeConversationListActivity('s'))).toBe('Sent 1 message in Test group');
    expect(vi.mocked(events.emit).mock.calls.length).toBeGreaterThan(count);
    noteNativeConversationActivity('s', foldedPreviewTurn(), fixture.db);
    await bridge.update({ sessionId: 's', preview: null });
    expect(label(nativeConversationListActivity('s'))).toBe('Sent 1 message in Test group');
    bridge.dispose();
    expect(label(nativeConversationListActivity('s'))).toBe('Sent 1 message in Test group');
  } finally { bridge.dispose(); }
});
