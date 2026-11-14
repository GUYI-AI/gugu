import { beforeEach, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

const person = '11111111-1111-4111-8111-111111111111';
const chat = '33333333-3333-4333-8333-333333333333';
const base = { id: '44444444-4444-4444-8444-444444444444', chat_id: chat, kind: 'file', filename: 'report.pdf', path: 'report.pdf', content_type: 'application/pdf', size_bytes: 20, pointer: 'chat/report', source_message_ids: [], created_by: person, version: 1, epoch: 0, parent_id: null, system_role: null, created_at: null, updated_at: null, metadata: {} };
let rows: Record<string, unknown>[];
const rpc = vi.fn((name: string) => {
  const data = name === 'workspace_get_as' ? [base] : name === 'file_resolve_as' ? { source: 'managed-object' } : rows;
  const answer = Promise.resolve({ data, error: null });
  return Object.assign(answer, { select: () => answer });
});
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const { createAppFiles } = await import('./app-files-core');
let platform: FilesPlatform;
beforeEach(() => {
  rows = [];
  vi.clearAllMocks();
  platform = { account: async () => ({ token: 'token', userId: person }), hasCapability: () => true, sync: { pageFor: () => ({}) } as never,
    identities: async () => [], faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn() };
});

it.each(['expired', 'deleted'] as const)('preserves %s without requiring a timestamp through both list and search', async availability => {
  rows = [{ ...base, availability, chat_name: 'Group', chat_kind: 'group' }];
  const files = createAppFiles(platform);
  for (const entries of [await files.groupFiles(chat), await files.search({ query: 'report' })]) {
    expect(entries[0]).toMatchObject({ id: base.id, availability });
    expect(entries[0]).not.toHaveProperty('expiredAt');
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
  expect(entries[1]).not.toHaveProperty('expiredAt');
});
