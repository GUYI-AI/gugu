import { canonicalPath } from '@gugu/session-core/files';
import os from 'node:os';
import fs from 'node:fs';
// 同一个文件夹换一种写法,不能被认成另一个项目(owner 10-10 在 Windows 上撞到两个同名项目)。
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projects } from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
import { getLocalProjectByPath, getProjectPathOccupant } from './getProjects';

/**
 * Rows hold the one spelling of their folder (`@@@canonical-path`): written so, old ones migrated at start. A lookup puts
 * whatever it is given in that spelling first — an alias, a trailing separator, `..` — and then compares by value.
 */
let base: string;
let real: string;
let alias: string;

describe('getLocalProjectByPath', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-path-')));
    real = path.join(base, 'account', 'gugu coordination 2');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(path.join(base, 'account'), path.join(base, 'alias'));
    alias = path.join(base, 'alias', 'gugu coordination 2');
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function insert(id: string, projectPath: string, extra: Partial<typeof projects.$inferInsert> = {}) {
    await fixture.db.insert(projects).values({ id, name: 'gugu coordination 2', path: canonicalPath(projectPath), ...extra });
  }

  it('finds its row however the folder is named: through an alias, with a trailing separator, with `..`', async () => {
    await insert('p-real', alias);
    for (const spelling of [real, alias, `${alias}${path.sep}`, path.join(alias, 'sub', '..')]) {
      expect((await getLocalProjectByPath(spelling))?.id, spelling).toBe('p-real');
    }
  });

  it('an SSH project is another machine’s folder: never compared', async () => {
    await insert('p-ssh', real, { workspaceProvider: 'ssh' });
    expect(await getLocalProjectByPath(real)).toBeUndefined();
  });

  it('a relative path fails loudly, never joined to the process cwd', async () => {
    await expect(getLocalProjectByPath('gugu coordination 2')).rejects.toThrow(/absolute/);
  });

  it('the conflict lookup asks in the spelling rows are written in', async () => {
    await insert('p-ssh', real, { workspaceProvider: 'ssh' });
    expect((await getProjectPathOccupant(`${alias}${path.sep}`))?.id).toBe('p-ssh');
  });
});
