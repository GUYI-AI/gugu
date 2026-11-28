import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { importProjectFile } from '../../../../apps/desktop/electron/projectFileImport';

const io = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), copyFile: io.copy }));
vi.mock('@gugu/core/local/childProcess', async original => ({
  ...await original<typeof import('@gugu/core/local/childProcess')>(),
  // macOS 上也测试 Node 复制回退路径，不依赖机器是否支持 APFS 克隆。
  execFile: (...args: unknown[]) => {
    if (args[0] !== '/bin/cp') throw new Error('Unexpected command in snapshot fixture');
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
    callback(Object.assign(new Error('Clone unsupported in fixture'), { code: 1 }), '', '');
  },
}));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(['first.bin', 'second.bin'])('concurrent sends of identical content share one verified snapshot (%s)', async secondName => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-import-order-')); roots.push(root);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const source = path.join(root, 'selected.bin'); await writeFile(source, 'data');
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  io.copy.mockReset(); io.copy.mockImplementation(fs.copyFile);
  io.copy.mockImplementationOnce(async (...args: Parameters<typeof copyFile>) => { await gate; return fs.copyFile(...args); });
  const first = importProjectFile(workspace, { path: source, name: 'first.bin', size: 4 });
  await vi.waitFor(() => expect(io.copy).toHaveBeenCalledOnce());
  const second = importProjectFile(workspace, { path: source, name: secondName, size: 4 });
  const other = path.join(root, 'other.bin'); await writeFile(other, 'different');
  await importProjectFile(workspace, { path: other, name: 'other.bin', size: 9 });
  release();
  const [one, two] = await Promise.all([first, second]);
  expect(one).toBe(two);
  expect(await readFile(one, 'utf8')).toBe('data');
});

it('a failed copy does not poison a later retry of the same content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-import-retry-')); roots.push(root);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const source = path.join(root, 'selected.bin'); await writeFile(source, 'data');
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  io.copy.mockReset(); io.copy.mockRejectedValueOnce(new Error('copy failed')); io.copy.mockImplementation(fs.copyFile);
  await expect(importProjectFile(workspace, { path: source, name: 'a.bin', size: 4 })).rejects.toThrow('copy failed');
  const saved = await importProjectFile(workspace, { path: source, name: 'a.bin', size: 4 });
  expect(await readFile(saved, 'utf8')).toBe('data');
});
