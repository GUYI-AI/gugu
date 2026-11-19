import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { canonicalPath } from '@gugu/session-core/files';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRevision } from '@gugu/core/shared/fileResolver';
import type { AppDb } from '@main/db/client';
import { legacyProjectAliases } from '@main/db/schema';

const h = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return h.db; } }));

// The rule: this device holds a version while the folder its holder key names is bound to the version's chat (or the
// key is the device store) — the account's chat.device_holds. The cache keeps the newest record per item and account.
describe('which file versions this device holds', () => {
  let fixture: FixtureDb;
  let dir: string;
  let folderId: string;
  let files: typeof import('./file-revisions');
  let folders: typeof import('./folders');
  let revision: FileRevision;
  const ref = { item_id: 'item', version: 1 };
  const noRecord = async () => null;

  beforeEach(async () => {
    vi.resetModules();
    fixture = await openFixture('empty');
    h.db = fixture.db;
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gugu-file-revisions-')));
    folders = await import('./folders');
    files = await import('./file-revisions');
    folderId = folders.ensureFolder(canonicalPath(dir)).id;
    folders.bindFolder(folderId, 'group');
    revision = {
      source: 'local', item_id: 'item', version: 1, chat_id: 'group', file_name: 'file.bin', content_type: 'application/octet-stream',
      size_bytes: 3, sha256: 'ab'.repeat(32), host_account_id: 'owner', host_device_id: 'host-device', host_project_id: folderId,
      relative_path: 'file.bin',
    };
    files.rememberFileRevision(revision, 'owner');
  });
  afterEach(async () => {
    fixture.close();
    if (!dir.includes('gugu-file-revisions-')) throw new Error('Unexpected fixture path');
    await rm(dir, { recursive: true, force: true });
  });

  it('partitions account, device, version and binding', async () => {
    expect(await files.readFileRevision(ref, 'owner', 'host-device', noRecord)).toEqual(revision);
    for (const [owner, device, version] of [['other', 'host-device', 1], ['owner', 'other-device', 1], ['owner', 'host-device', 2]] as const) {
      expect(await files.readFileRevision({ ...ref, version }, owner, device, noRecord)).toBeNull();
    }
    folders.bindFolder(folderId, 'other-group');
    expect(await files.readFileRevision(ref, 'owner', 'host-device', noRecord)).toBeNull();
  });

  it('an unbound folder holds nothing; bound again, what it sent is held again without asking', async () => {
    for (let n = 0; n < 4; n++) files.rememberFileRevision({ ...revision, item_id: `item-${n}` }, 'owner');
    for (let n = 0; n < 4; n++) expect(await files.readFileRevision({ item_id: `item-${n}`, version: 1 }, 'owner', 'host-device', noRecord)).not.toBeNull();
    const record = vi.fn(async () => revision);
    folders.bindFolder(folderId, null);
    expect(await files.readFileRevision(ref, 'owner', 'host-device', record)).toBeNull();
    folders.bindFolder(folderId, 'group');
    expect(await files.readFileRevision(ref, 'owner', 'host-device', record)).toEqual(revision);
    expect(record).not.toHaveBeenCalled();
    // The cache is rebuildable: without it the database's record answers, and is cached again.
    h.db!.run(sql`DELETE FROM file_revision_cache`);
    expect(await files.readFileRevision(ref, 'owner', 'host-device', record)).toEqual(revision);
    expect(record).toHaveBeenCalledWith(ref);
    record.mockClear();
    expect(await files.readFileRevision(ref, 'owner', 'host-device', record)).toEqual(revision);
    expect(record).not.toHaveBeenCalled();
  });

  it.each(['../secret', '/absolute', 'file/../secret', 'C:\\secret', 'a\u0000b'])('rejects unsafe path %j when remembered and when read', async (relative_path) => {
    expect(() => files.rememberFileRevision({ ...revision, relative_path }, 'owner')).toThrow();
    h.db!.run(sql`UPDATE file_revision_cache SET revision_json = ${JSON.stringify({ ...revision, relative_path })}`);
    await expect(files.readFileRevision(ref, 'owner', 'host-device', noRecord)).rejects.toThrow('Invalid local file revision');
  });

  it('does not remember a foreign-owner revision or one whose folder is not bound to its chat', () => {
    expect(() => files.rememberFileRevision({ ...revision, host_account_id: 'other' }, 'owner')).toThrow();
    expect(() => files.rememberFileRevision({ ...revision, chat_id: 'other' }, 'owner')).toThrow('Folder binding changed');
    expect(() => files.rememberFileRevision({ ...revision, chat_id: undefined }, 'owner')).toThrow();
  });

  // #719: a rename or move makes a version without new bytes; the database's record of it names this device.
  const renamed = () => ({ ...revision, version: 2, file_name: 'renamed.bin' });
  it('reads version 2 by its database record and then from the cache; no version named asks for the current one', async () => {
    const later = vi.fn(async () => renamed());
    expect(await files.readFileRevision({ ...ref, version: 2 }, 'owner', 'host-device', later)).toEqual(renamed());
    expect(later).toHaveBeenCalledWith({ item_id: 'item', version: 2 });
    later.mockClear();
    expect(await files.readFileRevision({ ...ref, version: 2 }, 'owner', 'host-device', later)).toEqual(renamed());
    expect(later).not.toHaveBeenCalled();
    expect(await files.readFileRevision({ item_id: 'item' }, 'owner', 'host-device', later)).toEqual(renamed());
    expect(later).toHaveBeenCalledWith({ item_id: 'item' });
  });

  it.each([
    ['another computer', { host_device_id: 'other-device' }], ['another account', { host_account_id: 'other' }],
    ['a folder not bound to the chat', { host_project_id: 'other' }], ['another chat', { chat_id: 'other' }],
    ['another version', { version: 3 }], ['bytes in the cloud', { source: 'managed-object' }], ['another file', { item_id: 'other-item' }],
  ] as const)('refuses when the database names %s', async (_, change) => {
    expect(await files.readFileRevision({ ...ref, version: 2 }, 'owner', 'host-device', async () => ({ ...renamed(), ...change }) as FileRevision)).toBeNull();
  });

  // Another member's device may write the next version; this device must not answer for the current one with its old bytes.
  it('answers no version named only while this device keeps the current version; a named older version stays local', async () => {
    const elsewhere = vi.fn(async () => ({ ...revision, version: 2, host_device_id: 'other-device', relative_path: 'item/file.bin', sha256: 'cd'.repeat(32), size_bytes: 74 }) as FileRevision);
    expect(await files.readFileRevision({ item_id: 'item' }, 'owner', 'host-device', elsewhere)).toBeNull();
    expect(await files.readFileRevision(ref, 'owner', 'host-device', elsewhere)).toEqual(revision);
    expect(await files.readFileRevision({ item_id: 'item' }, 'owner', 'host-device', async () => revision)).toEqual(revision);
    expect(await files.readFileRevision({ ...ref, version: 2 }, 'owner', 'host-device', async () => null)).toBeNull();
  });

  it('a released client\'s project key is held through that project\'s root folder, relative to its root', async () => {
    h.db!.insert(legacyProjectAliases).values({ projectId: 'old-project', rootWorkspaceId: folderId, chatId: 'group' }).run();
    const legacy = { ...revision, item_id: 'legacy', host_project_id: 'old-project' };
    expect(await files.readFileRevision({ item_id: 'legacy', version: 1 }, 'owner', 'host-device', async () => legacy)).toEqual(legacy);
    expect(files.holderRoot('old-project')).toBe(dir);
    folders.bindFolder(folderId, null);
    expect(await files.readFileRevision({ item_id: 'legacy', version: 1 }, 'owner', 'host-device', async () => legacy)).toBeNull();
  });

  it('the device store is held in any chat', async () => {
    const stored = { ...revision, item_id: 'stored', chat_id: 'any-chat', host_project_id: 'device-store' };
    expect(await files.readFileRevision({ item_id: 'stored', version: 1 }, 'owner', 'host-device', async () => stored)).toEqual(stored);
  });
});
