import { rpcQuery } from '../../../../../../tests/support/rpcQuery';
import { verifiedFileHandle } from '../../../../../../tests/support/verifiedFileHandle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';
import { FileReadRevokedError, type ResolvedFile } from '@gugu/core/shared/fileResolver';

/**
 * #1927 `readAtPath`: one file of one chat's folder by its path, as the signed-in person, for the host's conversation
 * binding (`gugu.bindings.read`). Its three ways of not being there to read are said apart; a door's refusal stays one.
 */
const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const OTHER_CHAT = '55555555-5555-4555-8555-555555555555';
const ITEM = '44444444-4444-4444-8444-444444444444';
const row = (patch: Record<string, unknown> = {}) => ({
  id: ITEM, chat_id: CHAT, kind: 'document', filename: 'today.json', content_type: 'application/json', size_bytes: 20,
  created_at: '2026-11-11T00:00:00Z', updated_at: '2026-11-11T01:00:00Z', created_by: PERSON, source_message_ids: [], pointer: null,
  epoch: 3, version: 2, parent_id: null, system_role: null, path: 'today.json', ...patch,
});
const state = vi.hoisted(() => ({
  found: [] as Record<string, unknown>[],
  listError: null as { message: string; hint?: string } | null,
  asked: [] as { name: string; args: Record<string, unknown> }[],
  resolved: null as (() => Promise<ResolvedFile | null>) | null,
}));
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => {
      state.asked.push({ name, args });
      if (name === 'workspace_list_as') return state.listError ? { data: null, error: state.listError } : { data: state.found.map(({ id }) => ({ id })), error: null };
      if (name === 'workspace_get_as') return { data: state.found.filter((found) => found.id === args.p_item_id), error: null };
      return { data: [], error: null };
    }),
  }),
}));
const { createAppFiles } = await import('./app-files-core');
const platform: FilesPlatform = {
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => false,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.test',
  warn: () => undefined,
  resolveFile: async () => state.resolved?.() ?? null,
};
const files = createAppFiles(platform);
const MAX = 1024;
const stored = (bytes: Uint8Array, fields: Record<string, unknown> = {}) => async () =>
  verifiedFileHandle(bytes, { item_id: ITEM, chat_id: CHAT, version: 2, file_name: 'today.json', content_type: 'application/json', ...fields });

beforeEach(() => {
  state.found = [row()];
  state.listError = null;
  state.asked = [];
  state.resolved = null;
});
afterEach(() => vi.unstubAllGlobals());

describe('a bound conversation\'s file by its path (#1927)', () => {
  it('asks the given chat alone, as the person, for the exact path', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ text: '{"days":[]}' }));
    state.found = [row({ path: 'notes/today.json', parent_id: '66666666-6666-4666-8666-666666666666' })];
    const read = await files.readAtPath(CHAT, 'notes/today.json', MAX);
    expect(state.asked[0]).toEqual({ name: 'workspace_list_as', args: { p_chat_id: CHAT, p_as_user_id: PERSON, p_name: 'today.json', p_folder: 'notes', p_exact: true } });
    expect(read).toMatchObject({ state: 'ready', content: '{"days":[]}', truncated: false, totalSize: 11, entry: { name: 'today.json', path: 'notes/today.json', version: 2 } });
  });

  it('missing: nothing at that path, a document the file service no longer has, a stored file deleted or cleared', async () => {
    state.found = [];
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'missing' });
    state.found = [row()];
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }));
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'missing' });
    state.found = [row({ kind: 'file' })];
    for (const status of ['gone', 'expired'] as const) {
      state.resolved = async () => ({ status, sha256: null });
      expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'missing' });
    }
  });

  it('unprepared: the file is there, its bytes not stored yet', async () => {
    state.found = [row({ kind: 'file' })];
    state.resolved = async () => ({ status: 'missing', sha256: null });
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'unprepared' });
  });

  it('unavailable: the folder, the file service or the resolver did not answer, or the machine keeping it is off', async () => {
    state.listError = { message: 'upstream timeout' };
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'unavailable' });
    state.listError = null;
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }));
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'unavailable' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'unavailable' });
    state.found = [row({ kind: 'file' })];
    state.resolved = async () => { throw new Error('resolver down'); };
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'unavailable' });
    state.resolved = stored(new TextEncoder().encode('{}'), {
      source: 'local', host_online: false, host_device_id: 'd', host_project_id: 'p', host_account_id: PERSON, relative_path: 'today.json',
    });
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'unavailable' });
  });

  it('a stored file\'s text, its binary as such, and one over the limit by its size alone', async () => {
    state.found = [row({ kind: 'file', size_bytes: 2 })];
    state.resolved = stored(new TextEncoder().encode('{}'));
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toMatchObject({ state: 'ready', content: '{}', exact: true, truncated: false, totalSize: 2 });
    state.found = [row({ kind: 'file', filename: 'a.png', content_type: 'image/png', size_bytes: 3 })];
    state.resolved = stored(new Uint8Array([0x89, 0, 1]), { file_name: 'a.png', content_type: 'image/png' });
    expect(await files.readAtPath(CHAT, 'a.png', MAX)).toMatchObject({ state: 'ready', content: '', binary: true, truncated: false });
    state.found = [row({ kind: 'file', size_bytes: MAX + 1 })];
    const resolve = vi.fn();
    state.resolved = resolve;
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toMatchObject({ state: 'ready', content: '', truncated: true, totalSize: MAX + 1 });
    expect(resolve).not.toHaveBeenCalled();
    // A row that does not say its size: the revision says it before any byte is read.
    state.found = [row({ kind: 'file', size_bytes: null })];
    const big = new Uint8Array(MAX + 5).fill(0x61);
    // Called when the first byte is read.
    const acquire = vi.fn(async () => big.slice());
    state.resolved = async () => verifiedFileHandle(big, { item_id: ITEM, chat_id: CHAT, version: 2, file_name: 'today.json', content_type: 'application/json' }, acquire);
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toMatchObject({ state: 'ready', content: '', truncated: true, totalSize: MAX + 5 });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('a row or revision of another chat is never this chat\'s file', async () => {
    state.found = [row({ chat_id: OTHER_CHAT })];
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'missing' });
    state.found = [row({ kind: 'file' })];
    state.resolved = stored(new TextEncoder().encode('{}'), { chat_id: OTHER_CHAT });
    expect(await files.readAtPath(CHAT, 'today.json', MAX)).toEqual({ state: 'missing' });
  });

  it('the file service or resolver refusing the account is a refusal, not a read to try again', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', async () => new Response('no', { status }));
      await expect(files.readAtPath(CHAT, 'today.json', MAX)).rejects.toMatchObject({ code: 'denied' });
    }
    state.found = [row({ kind: 'file' })];
    state.resolved = async () => { throw new FileReadRevokedError('access'); };
    await expect(files.readAtPath(CHAT, 'today.json', MAX)).rejects.toMatchObject({ code: 'denied' });
  });

  it('refusals stay refusals: not a member, a folder, more than one file', async () => {
    state.listError = { message: 'not a member', hint: 'workspace_not_member' };
    await expect(files.readAtPath(CHAT, 'today.json', MAX)).rejects.toMatchObject({ code: 'denied' });
    state.listError = null;
    state.found = [row({ kind: 'folder' })];
    await expect(files.readAtPath(CHAT, 'today.json', MAX)).rejects.toMatchObject({ code: 'invalid' });
    state.found = [row(), row({ id: '77777777-7777-4777-8777-777777777777' })];
    await expect(files.readAtPath(CHAT, 'today.json', MAX)).rejects.toMatchObject({ code: 'ambiguous' });
  });
});
