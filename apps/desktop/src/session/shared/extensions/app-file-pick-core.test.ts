import { rpcQuery } from '../../../../../../tests/support/rpcQuery';
import { describe, expect, it, vi } from 'vitest';
import type { AppFileEntry } from './app-runtime-protocol';

/**
 * API 60 `gugu.files.pick`: the files the person picks for a page open for it as the file the host handed it (`ctx.file`)
 * does — no capability — and the ones they did not pick stay closed to an App without `files:read`.
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const PICKED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = (id: string, filename: string) => ({ id, filename, path: filename, chat_id: CHAT, kind: 'document', content_type: 'text/markdown', size_bytes: 2, created_at: null, updated_at: null, created_by: PERSON, source_message_ids: [], pointer: null, version: 1, epoch: 1, system_role: null, parent_id: null });
const rows = [row(PICKED, 'notes.md'), row(OTHER, 'secret.md')];

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: () => { throw new Error('read through the doors') },
    rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => {
      if (name !== 'workspace_get_as') return { data: null, error: { message: `no answer staged for ${name}` } };
      const found = rows.find((candidate) => candidate.id === args.p_item_id);
      return found ? { data: [found], error: null } : { data: null, error: { message: 'not found', hint: 'workspace_item_not_found' } };
    }),
  }),
}));

const { createAppFiles, handedTo } = await import('./app-files-core');
const { fileMatches, filePickCallOf, pickableFiles, pickedEntries } = await import('./app-file-pick-core');

const grants: unknown[] = [];
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  // The App holds no file capability at all.
  hasCapability: () => false,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: (_page: unknown, grant: unknown) => grants.push(grant), revoke: () => undefined, ungrant: () => undefined } as never,
  claimant: () => null,
  identities: async () => [{ id: PERSON, name: 'Ann' }] as never,
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});

describe('a picked file is handed to the page', () => {
  const surface = { pageId: 7, extensionId: 'tree', itemId: null, picked: new Set([PICKED]) };

  it('opens read-write with no capability, as ctx.file does', async () => {
    const opened = await files.open(surface, { ref: { chat: CHAT, id: PICKED } });
    expect(opened.access).toBe('rw');
    expect(grants.at(-1)).toMatchObject({ itemId: PICKED, needs: null });
  });

  it('a file the person did not pick stays closed without files:read', async () => {
    await expect(files.open(surface, { ref: { chat: CHAT, id: OTHER } })).rejects.toMatchObject({ code: 'denied' });
    // Control: the same file, handed as ctx.file, opens.
    await expect(files.open({ ...surface, itemId: OTHER, picked: new Set() }, { ref: { chat: CHAT, id: OTHER } })).resolves.toMatchObject({ access: 'rw' });
  });

  it('one rule for both: ctx.file or a picked id', () => {
    expect(handedTo({ itemId: OTHER }, OTHER)).toBe(true);
    expect(handedTo({ itemId: null, picked: new Set([PICKED]) }, PICKED)).toBe(true);
    expect(handedTo({ itemId: null }, PICKED)).toBe(false);
  });
});

describe('what the sheet offers', () => {
  const entry = (id: string, path: string, updatedAt: string, more: Partial<AppFileEntry> = {}) =>
    ({ id, path, name: path.split('/').pop()!, suffix: `.${path.split('.').pop()}`, updatedAt, type: 'text', appState: false, ...more }) as AppFileEntry;
  const listed = [
    entry('1', '数据/ctDNA.csv', '2026-11-19T10:00:00Z'),
    entry('2', 'plan.md', '2026-11-20T09:00:00Z'),
    entry('3', '数据', '2026-11-20T10:00:00Z', { type: 'folder' }),
    entry('4', 'tree.tree.json', '2026-11-20T11:00:00Z', { appState: true }),
    entry('5', 'Results.XLSX', '2026-11-18T10:00:00Z', { suffix: '.xlsx' }),
  ];

  it('files only, newest first; suffixes keep the kinds asked, any case', () => {
    expect(pickableFiles(listed, null).map((one) => one.id)).toEqual(['2', '1', '5']);
    expect(pickableFiles(listed, ['.csv', '.xlsx']).map((one) => one.id)).toEqual(['1', '5']);
  });

  it('a search keeps the files whose path has it, as files.search matches', () => {
    expect(listed.filter((one) => fileMatches(one, ' 数据 ')).map((one) => one.id)).toEqual(['1', '3']);
    expect(fileMatches(listed[4]!, 'results')).toBe(true);
  });

  it('an id the sheet was not handed is not a pick', () => {
    expect(pickedEntries({ files: listed.slice(0, 2) }, ['2', '4', 'nope']).map((one) => one.id)).toEqual(['2']);
  });

  it('the call is read strictly: a chat place, kinds like .csv', () => {
    expect(filePickCallOf({ place: { chat: CHAT }, suffixes: ['.CSV'], multiple: true, upload: true })).toEqual({ chat: CHAT, suffixes: ['.csv'], multiple: true, upload: true });
    expect(() => filePickCallOf({ place: { workspace: `session:${PERSON}` } })).toThrow(/chat/);
    expect(() => filePickCallOf({ place: { chat: CHAT }, suffixes: ['csv'] })).toThrow(/suffixes/);
    expect(() => filePickCallOf({ place: { chat: CHAT }, title: '' })).toThrow(/title/);
  });
});
