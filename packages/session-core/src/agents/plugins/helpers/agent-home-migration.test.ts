import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResolvedAgentHome } from '../capabilities/config-root';
import { AgentHomeSpaceError, checkAgentHomeImportSpace, streamImportFile } from './agent-home-migration';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'agent-home-migration-'));
  roots.push(root);
  const source = join(root, 'source'), destination = join(root, 'destination');
  await fs.writeFile(source, Buffer.alloc(96 * 1024, 42));
  return { root, source, destination };
}

it('checkpoints the opened destination before copying with a live cancellation signal', async () => {
  const { root, source, destination } = await fixture();
  const checkpoint = vi.fn(async (identity: { ino: number; dev: number }) => {
    const opened = await fs.stat(destination);
    expect({ ino: opened.ino, dev: opened.dev }).toEqual(identity);
    expect(opened.size).toBe(0);
  });
  const signal = new AbortController().signal;
  const hash = await streamImportFile(source, destination, undefined, root, signal, checkpoint);
  expect(checkpoint).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(destination)).toEqual(await fs.readFile(source));
  expect(await streamImportFile(destination, undefined, hash, root, signal)).toBe(hash);
});

it('does not create a destination or checkpoint after cancellation', async () => {
  const { root, source, destination } = await fixture();
  const controller = new AbortController(), reason = new Error('closing');
  const checkpoint = vi.fn();
  controller.abort(reason);
  await expect(streamImportFile(source, destination, undefined, root, controller.signal, checkpoint)).rejects.toBe(reason);
  expect(checkpoint).not.toHaveBeenCalled();
  await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('honors cancellation after recording the destination inode and before copying bytes', async () => {
  const { root, source, destination } = await fixture();
  const controller = new AbortController(), reason = new Error('closing after checkpoint');
  let recorded = false;
  await expect(streamImportFile(source, destination, undefined, root, controller.signal, async () => {
    recorded = true;
    controller.abort(reason);
  })).rejects.toBe(reason);
  expect(recorded).toBe(true);
  expect((await fs.stat(destination)).size).toBe(0);
});

it('keeps relocation space exclusions alongside the import cancellation signal', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agent-home-space-options-'));
  roots.push(root);
  const home = { userConfigRoot: root, shadowHome: join(root, 'shadow'), credentialPaths: ['auth.json'], importGroups: [] } as unknown as ResolvedAgentHome;
  await fs.mkdir(home.shadowHome);
  await fs.writeFile(join(root, 'auth.json'), 'credential fixture');
  await fs.writeFile(join(home.shadowHome, 'existing'), 'staging fixture');
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 2 * 1024 ** 3 + 1, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>);
  const entries = [{ home, groups: new Set<never>() }], controller = new AbortController();
  await expect(checkAgentHomeImportSpace(entries, controller.signal, { includeStaging: false, includeCredentials: false })).resolves.toBeUndefined();
  await expect(checkAgentHomeImportSpace(entries, controller.signal)).rejects.toBeInstanceOf(AgentHomeSpaceError);
  controller.abort(new Error('closing space scan'));
  await expect(checkAgentHomeImportSpace(entries, controller.signal, { includeStaging: false, includeCredentials: false })).rejects.toThrow('closing space scan');
});
