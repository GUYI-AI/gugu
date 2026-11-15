import { rpcQuery } from '../../../../../../tests/support/rpcQuery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `files.create(place, content, { ifExists: 'use' })`: the file already at that name instead of a 「 (2)」 beside it. Two
 * slots of one widget open its shared state together the first time: both look, find nothing and make it — the folder
 * names the later one apart, which goes again, and both answer the first (the race `chatFile` already settles).
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const FOLDER = 'apps/vote/widgets';
const NAME = 'w1.json';

type Row = Record<string, unknown> & { id: string; filename: string; parent_id: string | null; kind: string };
const base = { chat_id: CHAT, content_type: 'application/json', size_bytes: 2, created_at: null, updated_at: null, created_by: PERSON, source_message_ids: [], pointer: null, version: 1, epoch: 1, system_role: null };
let rows: Row[] = [];
let calls: string[] = [];
let made = 0;
const id = () => `0000000${++made}-0000-4000-8000-000000000000`.slice(-36);

/** The folder a path (or a folder's id) names, as `workspace_folder_for` walks it; made on the way when asked. */
function folderFor(path: string, create: boolean): string | null | undefined {
  if (rows.some((row) => row.id === path && row.kind === 'folder')) return path;
  let parent: string | null = null;
  for (const part of path.split('/').filter(Boolean)) {
    let row = rows.find((candidate) => candidate.kind === 'folder' && candidate.parent_id === parent && candidate.filename === part);
    if (!row && !create) return undefined;
    if (!row) rows.push(row = { ...base, id: id(), kind: 'folder', filename: part, parent_id: parent });
    parent = row.id;
  }
  return parent;
}

/** The folder's doors as the database answers them: a name the folder already has gets 「 (2)」 on insert (20261016012659). */
function door(name: string, args: Record<string, unknown>): { data: unknown; error: { message: string; hint?: string } | null } {
  calls.push(name);
  if (name === 'workspace_list_as') {
    const parent = folderFor(String(args.p_folder ?? ''), false);
    if (parent === undefined) return { data: null, error: { message: 'no such folder', hint: 'workspace_folder_not_found' } };
    return { data: rows.filter((row) => row.parent_id === parent && row.filename === args.p_name), error: null };
  }
  if (name === 'workspace_get_as') {
    const row = rows.find((candidate) => candidate.id === args.p_item_id);
    return row ? { data: [row], error: null } : { data: null, error: { message: 'not found', hint: 'workspace_item_not_found' } };
  }
  if (name === 'workspace_mkdir_as') {
    const folder = folderFor(String(args.p_path), true);
    return { data: rows.filter((row) => row.id === folder), error: null };
  }
  if (name === 'workspace_create_document_as') {
    const parent = (args.p_folder ?? null) as string | null;
    const taken = rows.some((row) => row.parent_id === parent && row.filename === args.p_title);
    const row: Row = { ...base, id: id(), kind: 'document', filename: taken ? String(args.p_title).replace('.json', ' (2).json') : String(args.p_title), parent_id: parent, content: args.p_content };
    rows.push(row);
    return { data: [row], error: null };
  }
  if (name === 'workspace_delete_as') {
    const gone = rows.filter((row) => row.id === args.p_item_id);
    rows = rows.filter((row) => row.id !== args.p_item_id);
    return { data: gone, error: null };
  }
  return { data: null, error: { message: `no answer staged for ${name}` } };
}

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({ from: () => { throw new Error('read through the doors') }, rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => door(name, args)) }),
}));

const { createAppFiles } = await import('./app-files-core');

const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  claimant: () => null,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});

const create = (ifExists?: unknown) => files.create(CHAT, { name: NAME, folder: FOLDER, content: '{"votes":{}}', contentType: 'application/json', ...(ifExists === undefined ? {} : { ifExists }) });
const documents = () => rows.filter((row) => row.kind === 'document').map((row) => row.filename);

beforeEach(() => {
  rows = [];
  calls = [];
  made = 0;
});

describe("files.create with ifExists: 'use'", () => {
  it('two slots making it at once both get the one file: the later copy goes again', async () => {
    const [a, b] = await Promise.all([create('use'), create('use')]);
    expect(documents()).toEqual([NAME]);
    expect(a.id).toBe(b.id);
    expect(calls).toContain('workspace_delete_as');
  });

  it('without it, the same race leaves two files (what the option is for)', async () => {
    await Promise.all([create(), create()]);
    expect(documents()).toEqual([NAME, 'w1 (2).json']);
  });

  it('a file already there is answered as it is, nothing made', async () => {
    const first = await create();
    calls = [];
    expect((await create('use')).id).toBe(first.id);
    expect(calls).not.toContain('workspace_create_document_as');
  });

  it('the folder named by its id finds the same file', async () => {
    const first = await create();
    const folder = rows.find((row) => row.kind === 'folder' && row.filename === 'widgets')!.id;
    expect((await files.create(CHAT, { name: NAME, folder, content: '{}', contentType: 'application/json', ifExists: 'use' })).id).toBe(first.id);
  });

  it('any other value is refused, said', async () => {
    await expect(create('replace')).rejects.toMatchObject({ code: 'invalid' });
    expect(documents()).toEqual([]);
  });
});
