import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 主进程 ↔ 渲染层的取块一问一答:测试里扮演渲染层(answer = 那台机器上的文件;不 answer = 渲染层没接 / 那台机器没应答)。
const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ name: string; data: unknown }> = [];
  return {
    listeners,
    emitted,
    reset() {
      listeners.clear();
      emitted.length = 0;
    },
  };
});

vi.mock('electron', () => ({ protocol: { isProtocolHandled: () => false, handle: vi.fn() } }));
// Main's egress (its own tests cover routes and roots): here, what a cloud object request asked it and what it answers.
const objects = vi.hoisted(() => ({
  asked: [] as Array<{ url: string; range: string | null }>,
  answer: async (): Promise<Response> => new Response('0123456789', { status: 200 }),
}));
vi.mock('@gugu/core/shared/egress', async (actual) => ({
  ...(await actual<typeof import('@gugu/core/shared/egress')>()),
  egress: {
    fetch: async (url: string, init?: RequestInit) => {
      objects.asked.push({ url, range: new Headers(init?.headers).get('range') });
      return objects.answer();
    },
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../projects/utils', () => ({ resolveWorkspace: vi.fn(async () => null) }));
// The chat folder a document is in, as the signed-in person reads it (app-files.ts): one document and the files beside it.
const folder = vi.hoisted(() => ({
  files: new Map<string, { kind: 'file'; bytes: Uint8Array; type: string } | { kind: 'text'; text: string; type: string } | { kind: 'offline'; machine: string }>(),
  read: [] as string[],
}));
vi.mock('@main/core/extensions/app-files', () => ({
  chatDocumentPlace: async (itemId: string) => (itemId === 'doc-1' ? { chatId: 'chat-1', path: '设计/证据/page.html' } : null),
  besideChatDocument: async (chatId: string, path: string) => {
    folder.read.push(`${chatId}:${path}`);
    const found = folder.files.get(path);
    if (!found) return null;
    if (found.kind === 'offline') return { kind: 'offline', machine: found.machine, deviceId: 'dev-9' };
    if (found.kind === 'text') return { kind: 'text', text: found.text, contentType: found.type };
    const bytes = found.bytes;
    return {
      kind: 'file',
      contentType: found.type,
      file: { revision: { size_bytes: bytes.byteLength, content_type: found.type }, read: async (offset: number, length: number) => bytes.slice(offset, offset + length), dispose: async () => undefined },
    };
  },
}));
vi.mock('@main/lib/events', () => ({
  events: {
    on: (channel: { name: string }, cb: (data: unknown) => void) => {
      const set = bus.listeners.get(channel.name) ?? new Set();
      set.add(cb);
      bus.listeners.set(channel.name, set);
      return () => set.delete(cb);
    },
    emit: (channel: { name: string }, data: unknown) => bus.emitted.push({ name: channel.name, data }),
  },
}));

import { remotePreviewReadChannel, remotePreviewReadResultChannel } from '@shared/events/appEvents';
import { REMOTE_CHUNK_TIMEOUT_MS, bytesRequestRefused, createBytesPreview, createChatFolderPreview, createDocumentPreview, createPreview, createRemotePreview, handlePreviewRequest, previewAssetsChanged, releasePreview, setPreviewDocument } from './preview-protocol';
import { resolveWorkspace } from '../projects/utils';
import { previewDocumentHtml } from '@shared/preview/preview-link-script';
import { cloudObjectUrl } from '@shared/preview/preview-url';
import { EgressError } from '@gugu/core/shared/egress';

const ROOT = '/root/.config/咕咕/task-home';
const COPY = { unavailable: '没能打开 d22 上的这个网页。', outside: '这里只能打开 d22 上这条会话文件夹里的网页。' };

/** 渲染层:按路径从一份「那台机器上的文件」表里答每一问。 */
function answerFrom(files: Record<string, string>) {
  const timer = setInterval(() => {
    while (bus.emitted.length > 0) {
      const { name, data } = bus.emitted.shift()!;
      if (name !== remotePreviewReadChannel.name) continue;
      const request = data as { requestId: string; path: string; offset: number; length: number };
      const text = files[request.path];
      const reply =
        text === undefined
          ? { requestId: request.requestId, errorCode: 'not_found' }
          : {
              requestId: request.requestId,
              chunk: {
                size: Buffer.byteLength(text),
                etag: 'e1',
                data: Buffer.from(text).subarray(request.offset, request.offset + request.length).toString('base64'),
              },
            };
      for (const cb of bus.listeners.get(remotePreviewReadResultChannel.name) ?? []) cb(reply);
    }
  }, 1);
  return () => clearInterval(timer);
}

function register() {
  const created = createRemotePreview({ projectId: 'proj', workspaceId: 'ws', root: ROOT, surface: 'browser', failureCopy: COPY });
  if (!created) throw new Error('not registered');
  return created.previewId;
}

beforeEach(() => bus.reset());
afterEach(() => vi.useRealTimers());

describe('document-only group HTML transport', () => {
  it('serves and updates only the supplied document, then revokes access', async () => {
    vi.mocked(resolveWorkspace).mockClear();
    const preview = createDocumentPreview('<h1>group</h1>');
    const response = await handlePreviewRequest(new Request(preview.url), 'pane');
    expect(await response.text()).toBe(previewDocumentHtml('<h1>group</h1>', true));
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
    setPreviewDocument(preview.previewId, '<h1>updated</h1>');
    const updated = await handlePreviewRequest(new Request(preview.url + '?r=1#target'), 'pane');
    expect(await updated.text()).toBe(previewDocumentHtml('<h1>updated</h1>', true));
    for (const path of ['/probe.css', '/etc/passwd', '/%2fetc%2fpasswd', '/C:/Users/private.txt', '/']) {
      expect((await handlePreviewRequest(new Request(new URL(path, preview.url)), 'pane')).status).toBe(404);
    }
    expect((await handlePreviewRequest(new Request(preview.url), 'browser')).status).toBe(404);
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(bus.emitted).toEqual([]);
    releasePreview(preview.previewId);
    expect((await handlePreviewRequest(new Request(preview.url), 'pane')).status).toBe(404);
  });
});

describe('loaded preview dependencies (#1117)', () => {
  it('checks only actually requested in-root assets, with content comparisons for resync', async () => {
    const files: Record<string, string> = { '/w/site/a.css': 'body{color:red}' };
    const readBytes = vi.fn(async (path: string) => files[path] === undefined
      ? { success: false, error: { type: 'not_found' } }
      : { success: true, data: { bytes: Buffer.from(files[path]!), totalSize: files[path]!.length, truncated: false } });
    vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
    const preview = (await createPreview('p', 'w', '/w/site/index.html', '<link rel="stylesheet" href="a.css">'))!;
    try {
      await handlePreviewRequest(new Request(preview.url), 'pane');
      await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
      expect((await handlePreviewRequest(new Request(new URL('/%2e%2e%2foutside.css', preview.url)), 'pane')).status).toBe(403);
      readBytes.mockClear();
      expect(await previewAssetsChanged(preview.previewId, ['/w/site/report.md', '/w/site/sub/shot.png'])).toBe(false);
      expect(readBytes).not.toHaveBeenCalled();
      expect(await previewAssetsChanged(preview.previewId)).toBe(false);
      expect(readBytes.mock.calls.map(([path]) => path)).toEqual(['/w/site/a.css']);
      // A page may fetch its own HTML. That must not erase the already loaded CSS.
      await handlePreviewRequest(new Request(preview.url), 'pane');
      files['/w/site/a.css'] = 'body{color:blue}';
      expect(await previewAssetsChanged(preview.previewId, ['/w/site/a.css'])).toBe(true);
      expect(await previewAssetsChanged(preview.previewId)).toBe(true);
      // A new served generation establishes the new baseline and drops removed dependencies.
      setPreviewDocument(preview.previewId, '<p>no stylesheet now</p>');
      await handlePreviewRequest(new Request(preview.url), 'pane');
      expect(await previewAssetsChanged(preview.previewId)).toBe(false);
      await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
      expect(await previewAssetsChanged(preview.previewId)).toBe(false);
      delete files['/w/site/a.css'];
      expect(await previewAssetsChanged(preview.previewId)).toBe(true);
      setPreviewDocument(preview.previewId, '<link rel="stylesheet" href="a.css">');
      await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
      expect(await previewAssetsChanged(preview.previewId)).toBe(false);
      files['/w/site/a.css'] = 'restored';
      expect(await previewAssetsChanged(preview.previewId)).toBe(true);
    } finally { releasePreview(preview.previewId); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
    expect(await previewAssetsChanged(preview.previewId)).toBe(false);
  });

  it('uses the same fetched list for remote bytes instead of reading this computer', async () => {
    const files = { [`${ROOT}/a.css`]: 'one' };
    const stop = answerFrom(files);
    const preview = createRemotePreview({ projectId: 'p', workspaceId: 'w', root: ROOT, surface: 'pane', documentPath: `${ROOT}/index.html`, documentHtml: 'page' })!;
    try {
      await handlePreviewRequest(new Request(preview.url!), 'pane');
      await handlePreviewRequest(new Request(new URL('a.css', preview.url!)), 'pane');
      expect(await previewAssetsChanged(preview.previewId)).toBe(false);
      files[`${ROOT}/a.css`] = 'two';
      expect(await previewAssetsChanged(preview.previewId, [`${ROOT}/a.css`])).toBe(true);
    } finally { stop(); releasePreview(preview.previewId); }
  });
});

describe('gugu-preview handler for a page on another machine (#6264)', () => {
  it('serves a page from a non-ASCII session folder (d22: /root/.config/咕咕/task-home)', async () => {
    const stop = answerFrom({ [`${ROOT}/demo-site/index.html`]: '<h1>咕咕</h1>' });
    const id = register();
    const response = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'browser');
    stop();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<h1>咕咕</h1>');
    releasePreview(id);
  });

  it('never hangs: when nobody answers the read, it times out into a visible error page', async () => {
    vi.useFakeTimers();
    const id = register();
    const pending = handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'browser');
    await vi.advanceTimersByTimeAsync(REMOTE_CHUNK_TIMEOUT_MS + 10);
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain(COPY.unavailable);
    releasePreview(id);
  });

  it('a missing file and a path the machine refuses both become pages with a plain sentence', async () => {
    const stop = answerFrom({});
    const id = register();
    const missing = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/nope.css`), 'browser');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain(COPY.unavailable);
    const escaping = await handlePreviewRequest(new Request(`gugu-preview://${id}/../../etc/passwd`), 'browser');
    expect(escaping.status).toBeGreaterThanOrEqual(400);
    stop();
    releasePreview(id);
  });

  it('an unknown or released preview, or the wrong surface, answers a page instead of hanging', async () => {
    const id = register();
    const wrongSurface = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'pane');
    expect(wrongSurface.status).toBe(404);
    releasePreview(id);
    const released = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'browser');
    expect(released.status).toBe(404);
    expect(released.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(bus.emitted).toEqual([]);
  });

  // 「文件」页签里渲染的别的机器的 HTML 跑在这台电脑的渲染层里:明文 http/ws(localhost 只走这两种)一律不许,
  // ❌ 让它打到这台电脑自己的端口(2026-09-24 那一撞的另一条路)。
  it('a remote HTML preview in the file tab may not reach plain http/ws (this computer\'s localhost)', async () => {
    const created = createRemotePreview({
      projectId: 'proj',
      workspaceId: 'ws',
      root: ROOT,
      surface: 'pane',
      documentPath: `${ROOT}/a.html`,
      documentHtml: '<p>hi</p>',
      failureCopy: COPY,
    });
    if (!created) throw new Error('not registered');
    const response = await handlePreviewRequest(new Request(`gugu-preview://${created.previewId}/a.html`), 'pane');
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain('connect-src');
    expect(csp).not.toMatch(/\bhttp:|\bws:|localhost|\*/);
    releasePreview(created.previewId);
  });
});

import { PREVIEW_REQUEST_DEADLINE_MS } from './preview-protocol';
import { previewReloadQueue } from '@/components/preview/preview-reload';

it('review: a timed-out first asset remains observable to recovery resync', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const good = { success: true, data: { bytes: Buffer.from('body{color:blue}'), totalSize: 16, truncated: false } };
  const readBytes = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(good);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/site/index.html', '<link rel="stylesheet" href="a.css">'))!;
  try {
    const pending = handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    await vi.advanceTimersByTimeAsync(PREVIEW_REQUEST_DEADLINE_MS + 1);
    expect((await pending).status).toBe(504);
    const changed = await previewAssetsChanged(preview.previewId);
    expect(changed, 'the timed-out requested CSS must be checked when storage recovers').toBe(true);
  } finally { releasePreview(preview.previewId); finish?.(good); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
});

it('review: a stalled dependency check cannot pin all later changes forever', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const good = { success: true, data: { bytes: Buffer.from('one'), totalSize: 3, truncated: false } };
  const readBytes = vi.fn().mockResolvedValue(good);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/site/index.html', '<link rel="stylesheet" href="a.css">'))!;
  const reload = vi.fn(), error = vi.fn();
  const queue = previewReloadQueue(paths => previewAssetsChanged(preview.previewId, paths), reload, error);
  try {
    await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    readBytes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...good, data: { ...good.data, bytes: Buffer.from('two') } });
    queue.changed(['/w/site/a.css']);
    await vi.advanceTimersByTimeAsync(210);
    await vi.advanceTimersByTimeAsync(PREVIEW_REQUEST_DEADLINE_MS + 1);
    queue.changed();
    await vi.advanceTimersByTimeAsync(PREVIEW_REQUEST_DEADLINE_MS + 1);
    expect(reload.mock.calls.length + error.mock.calls.length, 'a full resync after the request deadline cannot remain silently pinned to the old page').toBeGreaterThan(0);
  } finally { queue.dispose(); releasePreview(preview.previewId); finish?.(good); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
});

it('review: the remote workspace fence refusal is excluded from fetched resources', async () => {
  vi.useFakeTimers(); let reads = 0;
  const timer = setInterval(() => {
    while(bus.emitted.length) {
      const {name,data}=bus.emitted.shift()!;
      if(name!==remotePreviewReadChannel.name)continue;
      reads++;
      const request=data as {requestId:string};
      for(const cb of bus.listeners.get(remotePreviewReadResultChannel.name) ?? []) cb({requestId:request.requestId,errorCode:'outside_workspace'});
    }
  },1);
  const preview=createRemotePreview({projectId:'p',workspaceId:'w',root:ROOT,surface:'pane',documentPath:ROOT+'/index.html',documentHtml:'page'})!;
  try {
    const pending=handlePreviewRequest(new Request(new URL('linked.css',preview.url!)), 'pane');
    await vi.advanceTimersByTimeAsync(10);expect((await pending).status).toBe(403);expect(reads).toBe(1);
    const check=previewAssetsChanged(preview.previewId);
    await vi.advanceTimersByTimeAsync(10);expect(await check).toBe(false);
    expect(reads, 'resync must not read a path refused by the actual remote workspace fence').toBe(1);
  } finally { clearInterval(timer);releasePreview(preview.previewId); }
});

it('does not replace a served timeout with unserved late bytes', async () => {
  vi.useFakeTimers();
  const good = { success: true, data: { bytes: Buffer.from('same'), totalSize: 4, truncated: false } };
  let finish!: (value: typeof good) => void;
  const readBytes = vi.fn().mockImplementationOnce(() => new Promise<typeof good>(resolve => { finish = resolve; })).mockResolvedValue(good);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/index.html', 'page'))!;
  try {
    const response = handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    await vi.advanceTimersByTimeAsync(PREVIEW_REQUEST_DEADLINE_MS + 1);
    expect((await response).status).toBe(504);
    finish(good); await vi.advanceTimersByTimeAsync(0);
    // Those bytes never reached the page. Only a new served request can establish their fingerprint.
    expect(await previewAssetsChanged(preview.previewId)).toBe(true);
    await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    expect(await previewAssetsChanged(preview.previewId)).toBe(false);
  } finally { releasePreview(preview.previewId); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
});

it('bounds a whole dependency scan and stops it after its pending read finishes late', async () => {
  vi.useFakeTimers();
  const good = { success: true, data: { bytes: Buffer.from('same'), totalSize: 4, truncated: false } };
  const readBytes = vi.fn().mockResolvedValue(good);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/index.html', 'page'))!;
  let finish!: (value: typeof good) => void;
  try {
    await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    await handlePreviewRequest(new Request(new URL('b.css', preview.url)), 'pane');
    readBytes.mockClear();
    readBytes.mockImplementationOnce(() => new Promise<typeof good>(resolve => { finish = resolve; }));
    const scan = previewAssetsChanged(preview.previewId).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(PREVIEW_REQUEST_DEADLINE_MS + 1);
    expect(String(await scan)).toContain('timed out');
    expect(readBytes).toHaveBeenCalledTimes(1);
    finish(good); await vi.advanceTimersByTimeAsync(0);
    expect(readBytes).toHaveBeenCalledTimes(1); // The expired scan must not start b.css.
    expect(await previewAssetsChanged(preview.previewId)).toBe(false);
    expect(readBytes).toHaveBeenCalledTimes(3); // A fresh scan still checks both dependencies.
  } finally { finish?.(good); releasePreview(preview.previewId); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
});

it('does not let an older timeout overwrite a newer response for the same resource', async () => {
  vi.useFakeTimers();
  const good = { success: true, data: { bytes: Buffer.from('new'), totalSize: 3, truncated: false } };
  let finish!: (value: typeof good) => void;
  const readBytes = vi.fn().mockImplementationOnce(() => new Promise<typeof good>(resolve => { finish = resolve; })).mockResolvedValue(good);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/index.html', 'page'))!;
  try {
    const stale = handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    expect((await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane')).status).toBe(200);
    await vi.advanceTimersByTimeAsync(PREVIEW_REQUEST_DEADLINE_MS + 1);
    expect((await stale).status).toBe(504);
    finish(good); await vi.advanceTimersByTimeAsync(0);
    expect(await previewAssetsChanged(preview.previewId)).toBe(false);
  } finally { finish?.(good); releasePreview(preview.previewId); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
});

it('keeps an unexpected failed read observable when storage recovers', async () => {
  const good = { success: true, data: { bytes: Buffer.from('ok'), totalSize: 2, truncated: false } };
  const readBytes = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(good);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/index.html', 'page'))!;
  try {
    expect((await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane')).status).toBe(500);
    expect(await previewAssetsChanged(preview.previewId)).toBe(true);
  } finally { releasePreview(preview.previewId); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
});

it('review r2: an in-flight refetch cannot erase the last bytes supplied to the page', async () => {
  const old = { success: true, data: { bytes: Buffer.from('old'), totalSize: 3, truncated: false } };
  const next = { success: true, data: { bytes: Buffer.from('new'), totalSize: 3, truncated: false } };
  const readBytes = vi.fn().mockResolvedValue(old);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/index.html', 'page'))!;
  let finish!: (value: typeof old) => void;
  let refetch: Promise<Response> | undefined;
  try {
    expect((await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane')).status).toBe(200);
    readBytes.mockImplementationOnce(() => new Promise<typeof old>(resolve => { finish = resolve; })).mockResolvedValue(next);
    refetch = handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    expect(await previewAssetsChanged(preview.previewId, ['/w/a.css']), 'the page already received old; a pending request cannot hide the disk change').toBe(true);
  } finally {
    releasePreview(preview.previewId); finish?.(next); await refetch; vi.mocked(resolveWorkspace).mockResolvedValue(null);
  }
});

it('review r2: an expired main-process scan does not start more remote chunks after its pending reply', async () => {
  vi.useFakeTimers();
  const path = ROOT + '/a.css';
  const preview = createRemotePreview({ projectId: 'p', workspaceId: 'w', root: ROOT, surface: 'pane', documentPath: ROOT + '/index.html', documentHtml: 'page' })!;
  const stop = answerFrom({ [path]: 'old' });
  const reply = (request: {requestId:string;length:number}, error = false) => {
    const result = error ? { requestId: request.requestId, errorCode: 'not_found' } : {
      requestId: request.requestId, chunk: { size: request.length * 10, etag: 'slow', data: Buffer.alloc(request.length, 'n').toString('base64') },
    };
    for (const cb of bus.listeners.get(remotePreviewReadResultChannel.name) ?? []) cb(result);
  };
  const take = () => {
    const item = bus.emitted.shift()!; expect(item?.name).toBe(remotePreviewReadChannel.name);
    return item.data as {requestId:string;length:number;offset:number};
  };
  try {
    const initial = handlePreviewRequest(new Request(new URL('a.css', preview.url!)), 'pane');
    await vi.advanceTimersByTimeAsync(10); expect((await initial).status).toBe(200); stop();
    const scan = previewAssetsChanged(preview.previewId).catch(error => error as Error);
    for(let i=0;i<4;i++) {
      const request=take(); await vi.advanceTimersByTimeAsync(19_000); reply(request); await vi.advanceTimersByTimeAsync(0);
    }
    const pending=take();
    await vi.advanceTimersByTimeAsync(14_001);
    expect(String(await scan)).toContain('timed out');
    reply(pending); await vi.advanceTimersByTimeAsync(0);
    expect(bus.emitted.map(x => (x.data as {offset:number}).offset), 'an expired scan must not issue the next remote readChunk').toEqual([]);
  } finally {
    stop(); releasePreview(preview.previewId);
    while(bus.emitted.length)reply(take(),true);
    await vi.advanceTimersByTimeAsync(0);
  }
});

it('keeps a served baseline when another request begins during a dependency check', async () => {
  const old = { success: true, data: { bytes: Buffer.from('old'), totalSize: 3, truncated: false } };
  const next = { ...old, data: { ...old.data, bytes: Buffer.from('new') } };
  const readBytes = vi.fn().mockResolvedValue(old);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/index.html', 'page'))!;
  let finishScan!: (value: typeof old) => void;
  let finishRefetch!: (value: typeof old) => void;
  let scanStarted!: () => void;
  let refetchStarted!: () => void;
  const scanning = new Promise<void>(resolve => { scanStarted = resolve; });
  const refetching = new Promise<void>(resolve => { refetchStarted = resolve; });
  let refetch: Promise<Response> | undefined;
  try {
    await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    readBytes.mockImplementationOnce(() => new Promise<typeof old>(resolve => { finishScan = resolve; scanStarted(); }))
      .mockImplementationOnce(() => new Promise<typeof old>(resolve => { finishRefetch = resolve; refetchStarted(); }));
    const scan = previewAssetsChanged(preview.previewId);
    await scanning;
    refetch = handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    await refetching;
    finishScan(next);
    expect(await scan).toBe(true);
    finishRefetch(next);
    expect((await refetch).status).toBe(200);
    readBytes.mockResolvedValue(next);
    expect(await previewAssetsChanged(preview.previewId)).toBe(false);
  } finally {
    finishScan?.(next); finishRefetch?.(next); await refetch;
    releasePreview(preview.previewId); vi.mocked(resolveWorkspace).mockResolvedValue(null);
  }
});

it('does not compare an old disk read against a newly supplied response', async () => {
  const old = { success: true, data: { bytes: Buffer.from('old'), totalSize: 3, truncated: false } };
  const next = { ...old, data: { ...old.data, bytes: Buffer.from('new') } };
  const readBytes = vi.fn().mockResolvedValue(old);
  vi.mocked(resolveWorkspace).mockResolvedValue({ path: '/w', fileSystem: { readBytes } } as never);
  const preview = (await createPreview('p', 'w', '/w/index.html', 'page'))!;
  let finish!: (value: typeof old) => void;
  try {
    await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    readBytes.mockImplementationOnce(() => new Promise<typeof old>(resolve => { finish = resolve; })).mockResolvedValue(next);
    const scan = previewAssetsChanged(preview.previewId);
    await handlePreviewRequest(new Request(new URL('a.css', preview.url)), 'pane');
    finish(old);
    expect(await scan).toBe(false);
    expect(await previewAssetsChanged(preview.previewId)).toBe(false);
  } finally { finish?.(old); releasePreview(preview.previewId); vi.mocked(resolveWorkspace).mockResolvedValue(null); }
});

it('cancels a timed-out served remote stream and removes its pending reply listener', async () => {
  vi.useFakeTimers();
  const preview = createRemotePreview({ projectId: 'p', workspaceId: 'w', root: ROOT, surface: 'pane', documentPath: ROOT + '/index.html', documentHtml: 'page' })!;
  const reply = (request: { requestId: string; length: number }) => {
    for (const cb of bus.listeners.get(remotePreviewReadResultChannel.name) ?? []) cb({
      requestId: request.requestId,
      chunk: { size: request.length * 10, etag: 'slow', data: Buffer.alloc(request.length, 'x').toString('base64') },
    });
  };
  const take = () => bus.emitted.shift()!.data as { requestId: string; length: number };
  try {
    const response = handlePreviewRequest(new Request(new URL('a.css', preview.url!)), 'pane');
    for (let i = 0; i < 4; i++) {
      const request = take();
      await vi.advanceTimersByTimeAsync(19_000);
      reply(request); await vi.advanceTimersByTimeAsync(0);
    }
    const pending = take();
    await vi.advanceTimersByTimeAsync(14_001);
    expect((await response).status).toBe(504);
    expect(bus.listeners.get(remotePreviewReadResultChannel.name)?.size).toBe(0);
    reply(pending); await vi.advanceTimersByTimeAsync(0);
    expect(bus.emitted).toEqual([]);
    const stop = answerFrom({ [ROOT + '/a.css']: 'recovered' });
    try {
      const scan = previewAssetsChanged(preview.previewId);
      await vi.advanceTimersByTimeAsync(10);
      expect(await scan).toBe(true);
    } finally { stop(); }
  } finally { releasePreview(preview.previewId); }
});

describe('a chat folder document previewed with its folder', () => {
  const copy = { unavailable: '这个文件现在取不到。', outside: '只能取到这份文档所在文件夹里的文件。', offline: '在「{machine}」上，设备离线', palette: { surface: 'white', border: 'gray', text: 'black' } };
  const get = (url: string, headers: Record<string, string> = {}) => handlePreviewRequest(new Request(url, { headers }), 'pane');

  it('gives the document its folder: the files beside it are served, a video by ranges, nothing above the folder', async () => {
    folder.files.clear();
    folder.files.set('设计/证据/shot.png', { kind: 'file', bytes: new Uint8Array([1, 2, 3, 4]), type: 'image/png' });
    folder.files.set('设计/证据/clips/a.mp4', { kind: 'file', bytes: new Uint8Array(Array.from({ length: 100 }, (_, i) => i)), type: 'video/mp4' });
    const created = await createChatFolderPreview('doc-1', '<img src="shot.png"><video src="clips/a.mp4">', copy);
    expect(created?.url).toMatch(/^gugu-preview:\/\/[0-9a-f]{32}\/page\.html$/);
    const base = created!.url.replace(/page\.html$/, '');

    const page = await get(created!.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("'self'");
    expect(await page.text()).toContain('<img src="shot.png">');

    const shot = await get(`${base}shot.png`);
    expect(shot.status).toBe(200);
    expect(new Uint8Array(await shot.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(folder.read).toContain('chat-1:设计/证据/shot.png');

    const piece = await get(`${base}clips/a.mp4`, { Range: 'bytes=10-19' });
    expect(piece.status).toBe(206);
    expect(piece.headers.get('Content-Range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await piece.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect((await get(`${base}clips/a.mp4`, { Range: 'bytes=200-' })).status).toBe(416);

    folder.read.length = 0;
    const above = await get(`${base}..%2Fsecret.png`);
    expect(above.status).toBe(403);
    expect(folder.read).toEqual([]);

    expect((await get(`${base}missing.png`)).status).toBe(404);
    releasePreview(created!.url.slice('gugu-preview://'.length, 'gugu-preview://'.length + 32));
  });

  it('a file on a machine that is off is said where it would be, and the page around it is told which machine', async () => {
    folder.files.clear();
    folder.files.set('设计/证据/shot.png', { kind: 'offline', machine: 'mac1' });
    folder.files.set('设计/证据/a.mp4', { kind: 'offline', machine: 'mac1' });
    bus.reset();
    const created = await createChatFolderPreview('doc-1', '<img src="shot.png">', copy);
    const base = created!.url.replace(/page\.html$/, '');
    const picture = await get(`${base}shot.png`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(await picture.text()).toContain('在「mac1」上，设备离线');
    expect(bus.emitted.map((event) => event.name)).toContain('session:preview-holder-offline');
    const video = await get(`${base}a.mp4`);
    expect(video.status).toBe(503);
    expect(await video.text()).toBe('在「mac1」上，设备离线');
  });

  it('a document someone may not read gets no preview', async () => {
    expect(await createChatFolderPreview('doc-2', '<p>x</p>', copy)).toBeNull();
  });
});

describe('this machine\'s bytes of a sha, at an address that names only the sha', () => {
  const sha = 'd'.repeat(64);
  const bytes = new TextEncoder().encode('0123456789');
  const file = { size: bytes.length, read: async (offset: number, length: number) => bytes.slice(offset, offset + length) };

  it('serves the whole file, a range for a video, and nothing at another path; released, it is gone', async () => {
    const { url, previewId } = createBytesPreview(sha, 'video/mp4', file);
    expect(url).toBe(`gugu-preview://${previewId}/${sha}`);
    const whole = await handlePreviewRequest(new Request(url), 'pane');
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    // Only the renderer may read it cross-origin: a page previewed on this scheme (untrusted HTML) may not.
    expect(whole.headers.get('access-control-allow-origin')).toBe('gugu-app://app');
    const fromPage = await handlePreviewRequest(new Request(url, { headers: { Origin: 'gugu-preview://0123abcd' } }), 'pane');
    expect(fromPage.headers.get('access-control-allow-origin')).toBe('gugu-app://app');
    expect(await whole.text()).toBe('0123456789');
    const part = await handlePreviewRequest(new Request(url, { headers: { Range: 'bytes=2-5' } }), 'pane');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await part.text()).toBe('2345');
    expect((await handlePreviewRequest(new Request(url, { headers: { Range: 'bytes=20-' } }), 'pane')).status).toBe(416);
    expect((await handlePreviewRequest(new Request(`gugu-preview://${previewId}/${'e'.repeat(64)}`), 'pane')).status).toBe(404);
    expect((await handlePreviewRequest(new Request(url), 'browser')).status).toBe(404);
    releasePreview(previewId);
    expect((await handlePreviewRequest(new Request(url), 'pane')).status).toBe(404);
  });

  // A page previewed on this scheme is untrusted: it may not read a sha address, even one whose URL it got hold of.
  it('only the renderer\'s own frame may ask for a sha address; a previewed page may not', () => {
    const { url, previewId } = createBytesPreview(sha, 'video/mp4', file);
    expect(bytesRequestRefused(url, 'gugu-app://app')).toBe(false);
    for (const page of ['null', `gugu-preview://${'0'.repeat(32)}`, undefined]) expect(bytesRequestRefused(url, page)).toBe(true);
    const document = createDocumentPreview('<p>page</p>');
    expect(bytesRequestRefused(document.url, 'null')).toBe(false);
    expect(bytesRequestRefused('https://example.com/', 'null')).toBe(false);
    releasePreview(previewId);
    releasePreview(document.previewId);
  });

  it('bytes that can no longer be read fail the response, loudly', async () => {
    const { url } = createBytesPreview(sha, '', { size: 10, read: async () => { throw new Error('NotReadableError'); } });
    await expect((await handlePreviewRequest(new Request(url), 'pane')).text()).rejects.toThrow();
  });
});

describe('a cloud object for the renderer, fetched by main', () => {
  const signed = 'https://files.example/u/object?Expires=1&Signature=a+b/c=';
  beforeEach(() => { objects.asked.length = 0; });

  it('forwards the range to the signed address and passes the store\'s answer through as it is', async () => {
    const url = cloudObjectUrl(signed);
    expect(url.startsWith('gugu-preview://object/')).toBe(true);
    objects.answer = async () => new Response('2345', { status: 206, headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4', 'content-type': 'video/mp4', 'cache-control': 'public, max-age=31536000, immutable', 'x-oss-request-id': 'kept-out' } });
    const part = await handlePreviewRequest(new Request(url, { headers: { Range: 'bytes=2-5' } }), 'pane');
    expect(objects.asked).toEqual([{ url: signed, range: 'bytes=2-5' }]);
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(part.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(part.headers.get('x-oss-request-id')).toBeNull();
    expect(part.headers.get('access-control-allow-origin')).toBe('gugu-app://app');
    expect(part.headers.get('access-control-expose-headers')).toBe('Content-Range');
    expect(await part.text()).toBe('2345');
    // An expired signature's refusal reaches the reader as the store said it: that is what renews it.
    objects.answer = async () => new Response(null, { status: 403 });
    expect((await handlePreviewRequest(new Request(url), 'pane')).status).toBe(403);
  });

  it('only the renderer\'s own frame may ask, only for https, and only on the pane surface', async () => {
    const url = cloudObjectUrl(signed);
    expect(bytesRequestRefused(url, 'gugu-app://app')).toBe(false);
    for (const page of ['null', `gugu-preview://${'0'.repeat(32)}`, undefined]) expect(bytesRequestRefused(url, page)).toBe(true);
    expect((await handlePreviewRequest(new Request(cloudObjectUrl('http://files.example/plain')), 'pane')).status).toBe(404);
    expect((await handlePreviewRequest(new Request('gugu-preview://object/%%%'), 'pane')).status).toBe(404);
    expect((await handlePreviewRequest(new Request(url), 'browser')).status).toBe(404);
    expect(objects.asked).toEqual([]);
  });

  it('passes the bytes on in pieces: a burst together, and what is ready at once when the network pauses', async () => {
    const piece = (n: number) => new Uint8Array(16 * 1024).fill(n);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    objects.answer = async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(piece(i)); // a burst the network had ready
        await paused;
        controller.enqueue(piece(9)); controller.close();
      },
    }), { status: 206, headers: { 'content-range': 'bytes 0-147455/147456' } });
    const answer = await handlePreviewRequest(new Request(cloudObjectUrl(signed), { headers: { Range: 'bytes=0-' } }), 'pane');
    const reader = answer.body!.getReader();
    const first = await reader.read();
    // The first piece is small, so a stream starts at once; the rest of the burst follows as one piece, without waiting
    // for the bytes still to come.
    expect(first.value?.byteLength).toBe(4 * 16 * 1024);
    expect((await reader.read()).value?.byteLength).toBe(4 * 16 * 1024);
    release();
    const second = await reader.read();
    expect(second.value?.byteLength).toBe(16 * 1024);
    expect((await reader.read()).done).toBe(true);
  });

  it('says a request that got no answer as that, with its kind, never as bytes', async () => {
    for (const kind of ['proxy', 'tls', 'connect'] as const) {
      objects.answer = async () => { throw new EgressError(kind, 'files.example'); };
      const failed = await handlePreviewRequest(new Request(cloudObjectUrl(signed)), 'pane');
      expect([failed.status, failed.headers.get('x-gugu-object-failure'), await failed.text()]).toEqual([502, kind, '']);
    }
  });
});

describe('a remote page on a machine a device link reaches (@@@machine-file-stream)', () => {
  it('reads the first piece through the machine\'s channel and the rest from one stream of that version', async () => {
    const { setMachineFileStreams } = await import('./machine-file-streams');
    const big = 'x'.repeat(3 * 1024 * 1024 + 7);
    const asked: number[] = [];
    const stop = answerFrom({ [`${ROOT}/site/big.js`]: big });
    const opened: Record<string, unknown>[] = [];
    setMachineFileStreams({
      linked: async (deviceId) => deviceId === 'dev-b',
      open: async (_deviceId, _type, request, size, from) => {
        opened.push(request(from, 's'));
        return { dispose: async () => undefined, read: async (offset: number, length: number) => { asked.push(offset); return new Uint8Array(Buffer.from(big.slice(offset, offset + Math.min(length, size - offset)))); } };
      },
    });
    const created = createRemotePreview({ projectId: 'proj', workspaceId: 'ws', machine: { deviceId: 'dev-b', projectId: 'proj-there', workspaceId: 'ws' }, root: ROOT, surface: 'browser', failureCopy: COPY })!;
    try {
      const response = await handlePreviewRequest(new Request(`gugu-preview://${created.previewId}/site/big.js`), 'browser');
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBe(big.length);
      expect(opened).toEqual([{ place: { projectId: 'proj-there', workspaceId: 'ws' }, path: `${ROOT}/site/big.js`, offset: asked[0], etag: 'e1', stream: 's' }]);
      expect(asked[0]).toBeGreaterThan(0);
    } finally { stop(); setMachineFileStreams(null); releasePreview(created.previewId); }
  });
});
