import type { WebContents } from 'electron';
import { acquireBrowserPage } from '../browser-page-runtime';
import { createPageProtocol } from '../page-protocol';

/** `playwright-core`'s `ConnectOverCDPTransport` shape. */
export interface PageCdpTransport {
  send(message: object): void;
  close(): void;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
}

type CdpRequest = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

const PAGE_SESSION = 'page-protocol-page';
const BROWSER_TARGET_ID = 'page-protocol-browser';

/**
 * Test only: Playwright connected straight to one page through the page protocol, as a Browser Use App's own program
 * connects through its task-page lease (taskPageSend and its events). The page protocol answers page commands; the
 * browser-level `Browser.*` / `Target.*` handshake Playwright starts with is answered here, reporting this one page.
 */
export function pageProtocolCdpTransport(contents: WebContents): PageCdpTransport {
  const page = acquireBrowserPage(contents);
  // Observe rejection immediately, including a connection closed before its first request.
  void page?.ready.catch(() => {});
  page?.setActive(true);
  const protocol = createPageProtocol(contents, { ready: page?.ready, capture: page ? params => page.capture(params) : undefined });
  const children = new Set<string>();
  let targetInfo: Record<string, unknown> | null = null;
  let closed = false;
  // The page can fail before connectOverCDP installs its close handler: told once it does.
  let closeReason: string | undefined;
  let closeHandler: PageCdpTransport['onclose'];
  let closeNotified = false;
  const notifyClose = () => {
    if (!closed || closeNotified || !closeHandler) return;
    closeNotified = true;
    closeHandler(closeReason);
  };
  const transport: PageCdpTransport = {
    send: (message) => void send(message as CdpRequest),
    close: () => {
      protocol.close('closed by the test');
      finish('closed by the test');
    },
    get onclose() { return closeHandler; },
    set onclose(handler) { closeHandler = handler; queueMicrotask(notifyClose); },
  };
  // Playwright does not accept an answer before send() has returned.
  const emit = (message: object) => setImmediate(() => { if (!closed) transport.onmessage?.(message); });
  function finish(reason: string) {
    if (closed) return;
    closed = true;
    closeReason = reason;
    page?.dispose();
    protocol.close(reason);
    notifyClose();
  }
  protocol.onMessage((method, params, childSessionId) => {
    if (method === 'Target.attachedToTarget') children.add(String((params as { sessionId?: unknown }).sessionId));
    if (method === 'Target.detachedFromTarget') children.delete(String((params as { sessionId?: unknown }).sessionId));
    emit({ method, params, sessionId: childSessionId || PAGE_SESSION });
  });
  protocol.onClose(finish);

  let dispatched: Promise<void> = Promise.resolve();
  type FrameTree = { frameTree: { frame: { url: string } } };
  /**
   * Chromium's initial document exists before any navigation commits; its frame has no URL while document.URL is
   * about:blank. Reported as that document, so attaching does not wait for a navigation.
   */
  async function frameTree(): Promise<FrameTree> {
    const tree = await protocol.send('Page.getFrameTree') as FrameTree;
    if (tree.frameTree.frame.url !== '' && tree.frameTree.frame.url !== ':') return tree;
    const document = await protocol.send('Runtime.evaluate', { expression: 'document.URL', returnByValue: true, silent: true }) as {
      result?: { value?: unknown }; exceptionDetails?: unknown;
    };
    const url = document.result?.value;
    if (document.exceptionDetails || typeof url !== 'string' || !url || url === ':') throw new Error('could not read the initial document URL');
    if (url === 'about:blank') return { ...tree, frameTree: { ...tree.frameTree, frame: { ...tree.frameTree.frame, url } } };
    // A navigation committed during the lookup: its whole tree.
    return await protocol.send('Page.getFrameTree') as FrameTree;
  }

  async function send({ id, method, params = {}, sessionId }: CdpRequest) {
    const reply = (result: unknown) => emit({ id, sessionId, result });
    const fail = (message: string) => emit({ id, sessionId, error: { message } });
    try {
      await (page?.ready ?? Promise.resolve());
      if (closed) return fail('the page was closed');
      if (!sessionId) {
        if (method === 'Browser.getVersion') {
          return reply({ protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '', userAgent: contents.getUserAgent(), jsVersion: process.versions.v8 });
        }
        if (method === 'Target.setAutoAttach') {
          targetInfo = ((await protocol.send('Target.getTargetInfo')) as { targetInfo: Record<string, unknown> }).targetInfo;
          reply({});
          return emit({ method: 'Target.attachedToTarget',
            params: { sessionId: PAGE_SESSION, targetInfo: { ...targetInfo, type: 'page', attached: true }, waitingForDebugger: false } });
        }
        if (method === 'Target.getTargetInfo') {
          return reply({ targetInfo: { targetId: BROWSER_TARGET_ID, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } });
        }
        if (method === 'Target.getBrowserContexts') return reply({ browserContextIds: [] });
        if (/^Browser\.(setDownloadBehavior|grantPermissions|resetPermissions)$/.test(method)) return reply({});
        return fail(`browser-level ${method} is not available: this connection drives one page`);
      }
      if (sessionId !== PAGE_SESSION && !children.has(sessionId)) return fail('unknown session');
      if (method === 'Target.getTargetInfo' && sessionId === PAGE_SESSION && targetInfo) return reply({ targetInfo: { ...targetInfo, type: 'page' } });
      // In arrival order: a command waits until the one before it was handed to the page. The frame tree is answered
      // whole first: Playwright enables Runtime right after it, and its context events must not overtake the tree.
      const prior = dispatched;
      let release = () => {};
      dispatched = new Promise<void>((resolve) => { release = resolve; });
      let result: Promise<unknown>;
      try {
        await prior;
        if (method === 'Page.getFrameTree' && sessionId === PAGE_SESSION) return reply(await frameTree());
        result = protocol.send(method, params, sessionId === PAGE_SESSION ? undefined : sessionId);
      } finally {
        release();
      }
      reply(await result);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return transport;
}
