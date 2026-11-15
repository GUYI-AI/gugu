import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@gugu/session-shared';

// 工作区:根 /root(d22 上「~」那一行的会话),realPath 原样返回(这里只钉路径围栏,不钉符号链接)。
const workspace = vi.hoisted(() => ({
  path: '/root',
  fileSystem: { realPath: async (p: string) => ({ success: true as const, data: p }) },
}));

vi.mock('electron', () => ({ protocol: { isProtocolHandled: () => false, handle: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { on: () => () => undefined, emit: vi.fn() } }));
vi.mock('../../projects/utils', () => ({
  resolveWorkspace: (_projectId: string, workspaceId: string) => (workspaceId === 'ws' ? workspace : null),
}));

import { workspaceFileSystemController } from './controller';

const { getAbsolutePath } = workspaceFileSystemController;

describe('workspace.files.getAbsolutePath', () => {
  // #6264 实机:别的机器上的会话点「查看预览」先问这条会话的工作目录(`.`),从前被「Path must not be empty」拒掉,
  // 预览恒显示「没能打开 d22 上的这个网页。」
  it.each(['.', ''])('%j 是工作区根本身', async (input) => {
    expect(await getAbsolutePath('p', 'ws', input)).toEqual(ok({ path: '/root' }));
  });

  it('工作区里的相对路径与绝对路径照旧', async () => {
    expect(await getAbsolutePath('p', 'ws', 'tab-demo/index.html')).toEqual(ok({ path: '/root/tab-demo/index.html' }));
    expect(await getAbsolutePath('p', 'ws', '/root/tab-demo/index.html')).toEqual(ok({ path: '/root/tab-demo/index.html' }));
  });

  it('工作区外仍然拒绝', async () => {
    for (const input of ['../etc/passwd', '/etc/passwd']) {
      const result = await getAbsolutePath('p', 'ws', input);
      expect(result.success).toBe(false);
    }
  });

  it('工作区不在 = not_found', async () => {
    const result = await getAbsolutePath('p', 'gone', '.');
    expect(result.success).toBe(false);
  });
});

describe('workspace.files.readChunk: what a page reads (a preview\'s resources) stays in the workspace', () => {
  it('a link out of the workspace and an absolute path outside it are refused; a file inside reads', async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'read-chunk-')));
    const root = path.join(base, 'repo');
    const key = path.join(base, 'home', '.ssh', 'id_ed25519');
    mkdirSync(root);
    mkdirSync(path.dirname(key), { recursive: true });
    writeFileSync(key, 'canary');
    writeFileSync(path.join(root, 'page.css'), 'body{}');
    symlinkSync(key, path.join(root, 'keys.css'));
    const before = workspace.path;
    workspace.path = root;
    try {
      const { readChunk } = workspaceFileSystemController;
      // A preview names its resources by absolute path under its root; the link is followed only to be refused.
      for (const named of [path.join(root, 'keys.css'), 'keys.css', key]) {
        const read = await readChunk('p', 'ws', { path: named, offset: 0, length: 100 });
        expect(read).toMatchObject({ success: false, error: { type: 'outside_workspace' } });
      }
      const inside = await readChunk('p', 'ws', { path: path.join(root, 'page.css'), offset: 0, length: 100 });
      expect(inside.success && Buffer.from(inside.data.data, 'base64').toString()).toBe('body{}');
    } finally {
      workspace.path = before;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
