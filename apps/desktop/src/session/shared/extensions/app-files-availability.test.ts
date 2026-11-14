import { beforeEach, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

const person = '11111111-1111-4111-8111-111111111111';
const chat = '33333333-3333-4333-8333-333333333333';
const base = { id: '44444444-4444-4444-8444-444444444444', chat_id: chat, kind: 'file', filename: 'report.pdf', path: 'report.pdf', content_type: 'application/pdf', size_bytes: 20, pointer: 'chat/report', source_message_ids: [], created_by: person, version: 1, epoch: 0, parent_id: null, system_role: null, created_at: null, updated_at: null, metadata: {} };
let rows: Record<string, unknown>[];
let metadataError: { code: string; message: string } | null;
const selections: string[] = [];
const rpc = vi.fn((name: string) => {
  const data = name === 'workspace_get_as' ? [base] : name === 'file_resolve_as' ? { source: 'managed-object' } : rows;
  const answer = Promise.resolve({ data, error: null });
  return Object.assign(answer, { select: (fields: string) => {
    selections.push(fields);
    return name === 'workspace_get_as' && metadataError && fields.includes('availability')
      ? Promise.resolve({ data: null, error: metadataError }) : answer;
  } });
});
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const { createAppFiles } = await import('./app-files-core');
let platform: FilesPlatform;
beforeEach(() => {
  rows = [];
  metadataError = null;
  selections.length = 0;
  vi.clearAllMocks();
  platform = { account: async () => ({ token: 'token', userId: person }), hasCapability: () => true, sync: { pageFor: () => ({}) } as never,
    identities: async () => [], faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn() };
});

it.each(['available', 'expired', 'deleted', 'unavailable'] as const)('preserves %s through list, search and recent without requiring a timestamp', async availability => {
  rows = [{ ...base, availability, chat_name: 'Group', chat_kind: 'group' }];
  const files = createAppFiles(platform);
  for (const entries of [await files.groupFiles(chat), await files.search({ query: 'report' }), await files.recent({})]) {
    expect(entries[0]).toMatchObject({ id: base.id, availability, expiredAt: null });
  }
});

it('carries the expiry timestamp and current state when a listed file changes', async () => {
  rows = [{ ...base, availability: 'expired', expired_at: '2026-11-15T00:00:00Z' }];
  const { entries } = await createAppFiles(platform).groupEntries(chat, [base.id]);
  expect(entries[0]).toMatchObject({ availability: 'expired', expiredAt: '2026-11-15T00:00:00Z' });
});

it('keeps old responses compatible and never infers device-copy expiry from the cloud timestamp', async () => {
  rows = [{ ...base }, { ...base, id: 'device-copy', availability: 'available', host_device_id: 'device', copy_expired_at: '2026-11-15T00:00:00Z' }];
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries[0]).not.toHaveProperty('availability');
  expect(entries[0]).not.toHaveProperty('expiredAt');
  expect(entries[1]).toMatchObject({ availability: 'available' });
  expect(entries[1]).toHaveProperty('expiredAt', null);
});

it.each(['available', 'deleted', 'unavailable'] as const)('%s never inherits a cleared cloud copy expiry', async availability => {
  rows = [{ ...base, availability, expired_at: null, copy_expired_at: '2026-11-15T00:00:00Z' }];
  expect((await createAppFiles(platform).groupFiles(chat))[0]).toMatchObject({ availability, expiredAt: null });
});

it('keeps each historical version independent of current availability, including old responses', async () => {
  rows = [
    { n: 4, made_at: '2026-11-15T00:00:00Z', availability: 'available', expired_at: null },
    { n: 3, made_at: '2026-11-14T00:00:00Z', availability: 'expired', expired_at: '2026-11-15T00:00:00Z' },
    { n: 2, made_at: '2026-11-13T00:00:00Z', availability: 'unavailable', expired_at: null },
    { n: 1, made_at: '2026-11-12T00:00:00Z' },
  ];
  const versions = await createAppFiles(platform).versions({ extensionId: 'workspace', pageId: 1, itemId: null }, { ref: { id: base.id } });
  expect(versions.map(v => [v.n, v.availability, v.expiredAt])).toEqual([
    [4, 'available', null], [3, 'expired', '2026-11-15T00:00:00Z'], [2, 'unavailable', null], [1, undefined, undefined],
  ]);
});

it('reads new entry metadata without document bodies, and falls back only for missing contract columns', async () => {
  metadataError = { code: '42703', message: 'column availability does not exist' };
  const { entries } = await createAppFiles(platform).groupEntries(chat, [base.id]);
  expect(entries).toHaveLength(1);
  expect(selections).toHaveLength(2);
  expect(selections[0]).toContain(',availability,expired_at');
  expect(selections[1]).not.toContain('availability');
  expect(selections.join()).not.toMatch(/inline_text|\*/);
});

it('does not retry a denied metadata read or expose a status', async () => {
  metadataError = { code: '42501', message: 'availability denied' };
  await expect(createAppFiles(platform).groupEntries(chat, [base.id])).rejects.toThrow('availability denied');
  expect(selections).toHaveLength(1);
});
