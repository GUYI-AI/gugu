import { observer } from 'mobx-react-lite';
import { reaction } from 'mobx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { extensionSurfaceStore } from './extension-surface-store';
import { extensionViewStore, type ExtensionViewClaim } from './extension-view-store';
import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';
import { LOCAL_HOST, peekInstalledAppsTracked, useInstalledApps } from './installed-extensions';
import { AppSettingsPage } from './app-settings-page';
import { ExtensionGuestBinding, type ExtensionGuestTarget } from './extension-guest-binding';
import { nativeAppSurfaceMetrics, observeNativeSurfaceOcclusion } from './native-app-surface';
import { pageCorners } from './page-corners';
import { tabFullscreen } from '@renderer/features/tabs/tab-fullscreen';
import { bindAppPageZoom } from '@/components/preview/file-content-zoom';
import { clippedElementBox, elementBox, type ElementBox as Box } from '@/lib/elementVisibility';
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import { useTheme } from '@/store/theme';
import { widgetSnapshotWebP, widgetSnapshots, widgetWidthBucket } from '@/lib/widgetSnapshots';
import { widgetSnapshot, widgetSnapshotDataUrl } from '@/lib/widgetSnapshot';
import { PageLoading } from '@/lib/loading/PageLoading';

/**
 * 常驻扩展的页都住在这一层:每个 App 在每个地方(一个群、一个任务)一张,一生不换地方(摩擦单 F48,
 * extension-view-store)。
 *
 * 挂在会话页的根上(App.tsx),不挂在 Workspace 里:聊天页打开「新建 Agent」时会话页切到
 * composer 视图,Workspace 整棵卸载,挂在它里面的页会跟着销毁(L3 第 3 步;报告 5 §1.5)。
 * 落点不止会话格:dock、群右栏也向同一张页认领(extension-view-store 的认领栈)。
 *
 * 网页换父节点会重载:页常驻在会话树外,只跟随当前认领槽摆位、换使用者(behavior tab-extensions)。
 * 根测量容器不建堆叠上下文:每张 guest 与 divider/pane 都读 tokens.css 的同一层级表。
 * 一格都没在屏上时页藏起来但活着(后台那份状态本来也不靠它),因为下一次它要**立刻**出现,
 * 而不是再准备一次。但它只在**第一次有格要它**时才建(从入口打开、以后的 dock):
 * ❌ 装好就起一张谁也没要的隐藏页(摩擦单 F3)。
 *
 * 文件页按地方与文件各一张,同样常驻,一生不换文件。
 */
export const ExtensionViewLayer = observer(function ExtensionViewLayer() {
  // Who is signed in, from the shell's bridge: this page is a React root of its own, outside AuthContext.
  const identity = readSelfIdentityBridge();
  const accountId = useSyncExternalStore((listener) => identity?.subscribe(listener) ?? (() => {}), () => identity?.getSnapshot()?.userId ?? null);
  // Widget pictures belong to the account that saw them (a message's widget page lives in its bubble, not here).
  useLayoutEffect(() => {
    void widgetSnapshots.setAccount(accountId).catch(error => log.warn('Widget pictures could not be cleared:', error));
  }, [accountId]);
  const layerRef = useRef<HTMLDivElement | null>(null);
  // Switched off or removed: its shared page goes, and switched on again it waits to be wanted.
  useEffect(
    () =>
      reaction(
        () => peekInstalledAppsTracked()?.residentTabContributions.map((contribution) => contribution.kind) ?? null,
        (now, before) => {
          if (now && before) for (const kind of before) if (!now.includes(kind)) extensionViewStore.forgetOpened(kind);
        }
      ),
    []
  );
  const installed = useInstalledApps(LOCAL_HOST);
  if (installed.state !== 'value') return <div ref={layerRef} data-slot="extension-view-layer" className="pointer-events-none absolute inset-0" />;
  const contributions = installed.value.residentTabContributions;
  const enabled = new Map<string, (typeof contributions)[number]>(
    contributions.map((contribution) => [contribution.kind, contribution])
  );
  return (
    <div
      ref={layerRef}
      data-slot="extension-view-layer"
      className="pointer-events-none absolute inset-0"
    >
      {[...extensionViewStore.residentPages.values()].map((page) => {
        const contribution = enabled.get(page.kind);
        return contribution ? (
          <ExtensionPage
            key={page.key}
            kind={page.kind}
            extensionId={contribution.extensionId}
            layerRef={layerRef}
            pageKey={page.key}
            itemId={page.itemId}
            managed={contribution.hostSettings}
          />
        ) : null;
      })}
    </div>
  );
});

/** Following a claimed slot's box after it appears: until it holds still this many frames, or this long. */
const FOLLOW_STILL_FRAMES = 10;
const FOLLOW_MAX_MS = 2_000;

function releaseHiddenFocus(box: HTMLElement, claim?: ExtensionViewClaim): void {
  const focused = box.ownerDocument.activeElement;
  if (!(focused instanceof HTMLElement) || !box.contains(focused)) return;
  // A resident guest is outside its pane and can retain native focus after
  // DOM blur. Use the existing window host-focus route, then its pane context.
  void rpc.browser.focusHost(box.ownerDocument.defaultView?.name ?? '')
    .catch((error: unknown) => log.warn('Failed to return extension focus to its host:', error));
  focused.blur();
  claim?.focusContent?.();
}

interface Surface {
  partition: string;
  entryUrl: string;
}

/**
 * 认领方的一格在屏上占的框,以及它**实际露出来**的那部分。
 *
 * 两个框都要:面板收起时是把宽度压到 0 再 overflow-hidden,里面那一格的布局框还是 320 宽 ——
 * 只看它自己的框,页会画在一个早已被裁掉的位置上。所以沿祖先把每一层 overflow 不是 visible
 * 的框都交一遍,得到真正可见的区域;页按露出的区域裁,内容按整格的框摆,不变形。
 * fixed 全屏格是裁剪边界:格外原分栏的 overflow 不再裁它,格内与根层的裁剪仍然有效。
 * 两边都按视口量,再换算到本层坐标,祖先有 transform 也不歪。
 */
function boxOf(element: HTMLElement, layer: HTMLElement): { full: Box; clip: Box } {
  const l = elementBox(layer);
  const { full, clip } = clippedElementBox(element, l);
  const toLayer = (b: Box): Box => ({
    left: Math.round(b.left - l.left),
    top: Math.round(b.top - l.top),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });
  return { full: toLayer(full), clip: toLayer(clip) };
}

/** 从那一格往上到文档根的每一层(穿过 shadow root):任何一层的尺寸一变,格的位置都可能变。 */
function ancestorsOf(element: HTMLElement): Element[] {
  const out: Element[] = [];
  let node: Node | null = element;
  while (node) {
    if (node instanceof Element) out.push(node);
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return out;
}

/**
 * One App page in the layer, for one place and optionally one file. It follows whichever slot claims it now.
 */
export const ExtensionPage = observer(function ExtensionPage({
  kind,
  extensionId,
  layerRef: residentLayerRef,
  pageKey,
  itemId,
  managed = false,
  inline,
  accountId,
  onPainted,
}: {
  kind: string;
  extensionId: string;
  layerRef?: React.RefObject<HTMLDivElement | null>;
  pageKey?: string;
  itemId?: string;
  /** Host settings page: no App HTML or webview. */
  managed?: boolean;
  /**
   * A message's widget: its page lives in the bubble's own box, in the document flow, so the list scrolls and clips it
   * with the bubble in the same compositor frame. It is destroyed with that box (its row leaving the list); the bubble's
   * snapshot covers it until it paints again.
   */
  inline?: ExtensionGuestTarget;
  /** The account viewing an inline widget: its pictures are saved under it. */
  accountId?: string;
  /** An inline page's first paint (true) and its loss (false, its guest replaced). */
  onPainted?: (painted: boolean) => void;
}) {
  const unusedLayerRef = useRef<HTMLDivElement | null>(null);
  const layerRef = residentLayerRef ?? unusedLayerRef;
  const installed = useInstalledApps(LOCAL_HOST);
  const claimOf = useCallback(
    () => pageKey === undefined ? undefined : extensionViewStore.claims.get(pageKey),
    [pageKey]
  );
  const [surface, setSurface] = useState<Surface | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 整格大小的那层,在裁剪框里按偏移摆;webview 填满它。 */
  const innerRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const guestReadyRef = useRef<BrowserWebviewElement | null>(null);
  const [guestBinding] = useState(() => new ExtensionGuestBinding({
    bind: (webContentsId, target) => rpc.extensions.bindSurface({ ...target, webContentsId, extensionId, tabKind: kind }),
    retarget: (webContentsId, target) => rpc.extensions.retargetSurface({ ...target, webContentsId }),
  }));
  const guestTeardownRef = useRef<(() => void) | null>(null);
  /** 页此刻登记在哪一格名下(仅为了切走时把那一格的登记清掉)。 */
  const registeredRef = useRef<{ sessionId: string | null; tabId: string } | null>(null);
  /** 上一位认领方那一格的观察者;换格或卸载时先拆。 */
  const teardownRef = useRef<(() => void) | null>(null);
  const lastReportRef = useRef<string>('');
  /** 每次指向的序号:A→B→A 快速切换时,晚落地的 B 那次不许再往登记表里写。 */
  const aimSeqRef = useRef(0);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const paintedRef = useRef(false);
  // An inline page's target and viewer, read when its guest binds or a picture is taken: a new target object retargets
  // the bound page (below), it never re-attaches the guest.
  const inlineRef = useRef(inline);
  inlineRef.current = inline;
  const isInline = inline !== undefined;
  const accountIdRef = useRef(accountId);
  accountIdRef.current = accountId;
  const onPaintedRef = useRef(onPainted);
  onPaintedRef.current = onPainted;
  const [inlinePainted, setInlinePainted] = useState(false);
  const lastCaptureRef = useRef(-Infinity);
  const capturingRef = useRef(false);
  const pendingCaptureRef = useRef(false);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const capture = useCallback(function capture() {
    clearTimeout(captureTimerRef.current);
    const widgetId = inlineRef.current?.widget?.id;
    const element = boxRef.current;
    const account = widgetSnapshots.capture();
    const webContentsId = guestBinding.boundWebContentsId;
    if (!widgetId || !element || !account || accountIdRef.current !== account.accountId || webContentsId === null
      || !paintedRef.current || document.visibilityState === 'hidden' || !element.isConnected) return;
    const { clip } = clippedElementBox(element, { left: 0, top: 0, width: innerWidth, height: innerHeight });
    if (clip.width <= 0 || clip.height <= 0 || !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
    if (capturingRef.current) { pendingCaptureRef.current = true; return; }
    const remaining = 2_000 - (performance.now() - lastCaptureRef.current);
    if (remaining > 0) { captureTimerRef.current = setTimeout(capture, remaining); return; }
    const width = element.clientWidth;
    if (width <= 0) return;
    lastCaptureRef.current = performance.now();
    capturingRef.current = true;
    const theme = themeRef.current;
    // Bound to the account now: a picture that lands after a switch goes nowhere (no account the replica follows: none shown).
    const shown = widgetSnapshot.key(widgetId, theme, widgetWidthBucket(width)) ? widgetSnapshot.at(widgetId, theme, widgetWidthBucket(width)) : null;
    void rpc.extensions.captureWidget({ webContentsId, widgetId }).then(async reply => {
      if (!reply.success || !reply.data) return;
      const blob = await widgetSnapshotWebP(reply.data, width);
      if (blob && await widgetSnapshots.put(account, widgetId, theme, width, blob)) shown?.set(await widgetSnapshotDataUrl(blob));
    }).catch(error => log.warn('Widget picture could not be saved:', error))
      .finally(() => {
        capturingRef.current = false;
        if (pendingCaptureRef.current) { pendingCaptureRef.current = false; capture(); }
      });
  }, [guestBinding]);
  useEffect(() => () => { clearTimeout(captureTimerRef.current); pendingCaptureRef.current = false; }, [capture]);

  // @@@effect-flow(lifecycle) - activates the App's page in main (starts its guest) and binds the webview to the surface it returns
  useEffect(() => {
    if (managed) return;
    let disposed = false;
    setSurface(null);
    void rpc.extensions
      .activate({ extensionId, tabKind: kind })
      .then((result) => {
        if (disposed) return;
        if (result.success && result.data) setSurface(result.data);
        else log.warn('Extension activation failed:', result.error);
      })
      .catch((error: unknown) => {
        if (!disposed) log.warn('Extension activation failed:', error);
      });
    return () => {
      disposed = true;
    };
  }, [extensionId, kind, managed]);

  /** 尺寸与可见性报给桥(它会去重);没绑定时无处可报,静默。 */
  const report = useCallback((visible: boolean, width: number, height: number) => {
    const webContentsId = guestBinding.boundWebContentsId;
    if (webContentsId === null || guestReadyRef.current !== webviewRef.current) return;
    const element = webviewRef.current, clipElement = boxRef.current;
    if (!element || !clipElement) return;
    const metrics = nativeAppSurfaceMetrics(element, clipElement, visible, width, height);
    const key = JSON.stringify(metrics);
    if (key === lastReportRef.current) return;
    lastReportRef.current = key;
    void rpc.extensions
      .reportLayout({ webContentsId, ...metrics })
      .catch((error: unknown) => log.warn('Failed to report extension surface layout:', error));
  }, [guestBinding]);

  /** 把页交给此刻的认领方:第一次是 bind,之后每换一格是 retarget。没有认领方就只记账。 */
  const aimAt = useCallback(
    (claim: ExtensionViewClaim | undefined) => {
      if (managed) {
        if (claim) extensionViewStore.setHostPageReady(claim.token);
        return;
      }
      const webview = webviewRef.current;
      if (!webview || guestReadyRef.current !== webview) return;
      const seq = ++aimSeqRef.current;
      const previous = registeredRef.current;
      if (previous && (!claim || previous.sessionId !== (claim.sessionId ?? null) || previous.tabId !== claim.tabId)) {
        extensionSurfaceStore.setWebContentsId(previous.sessionId, previous.tabId, null);
        registeredRef.current = null;
      }
      const inlineTarget = inlineRef.current;
      if (!claim && !inlineTarget) return;
      const target = inlineTarget ?? {
        // Where it is (`AppWhere`): a group's side panel works on no working copy, a session's tab is in its agent's chat.
        workspace: claim?.sessionId ? sessionWorkspace(claim.sessionId) : null,
        // A chat's slot is in that chat; a session's slot in the person's private chat with its agent.
        conversation: claim?.chatId ?? claim?.conversation ?? null,
        ...(claim?.resourceChat ? { resourceChat: claim.resourceChat } : {}),
        tabId: claim?.tabId ?? '',
        viewState: claim?.viewState,
        navigation: claim?.navigation,
        ...(claim?.itemId ? { itemId: claim.itemId } : {}),
        ...(claim?.takeOpening ? { opening: claim.takeOpening() } : {}),
      };
      void guestBinding.aim(target)
        .then((result) => {
          if (!result) return;
          if (!result.success) {
            log.warn('Extension surface binding refused:', result.error);
            return;
          }
          const { webContentsId } = result;
          if (inlineTarget) {
            const box = boxRef.current;
            if (box) report(document.visibilityState === 'visible', box.clientWidth, box.clientHeight);
            return;
          }
          if (!claim) return;
          // The slot that claimed it can now reach this page (its header's toolbar / menu, 摩擦单 F13).
          extensionViewStore.setSurface(claim.token, webContentsId);
          // 这期间又指向别处了:登记表归最新那次管,这次的落地只算 bind 成功,别的不写。
          if (seq !== aimSeqRef.current) return;
          // Where its chrome (title / badge / error, the toolbar's commands) finds it: by the slot's session, none for a
          // slot in no session (a group's panel, the rail's page before any session).
          registeredRef.current = { sessionId: claim.sessionId ?? null, tabId: claim.tabId };
          extensionSurfaceStore.setWebContentsId(claim.sessionId ?? null, claim.tabId, webContentsId);
          // bind 之前的尺寸汇报都无处可去;现在补一次,让页第一帧就按真实宽度排版。
          lastReportRef.current = '';
          const layer = layerRef.current;
          if (layer) {
            const { full, clip } = boxOf(claim.element, layer);
            report(clip.width > 0 && clip.height > 0 && document.visibilityState === 'visible', full.width, full.height);
          }
        })
        .catch((error: unknown) => {
          log.warn('Extension surface binding failed:', error);
        });
    },
    [guestBinding, layerRef, report, managed]
  );
  // A new target for the inline page (its message or data changed): the bound guest is retargeted, never re-attached.
  useEffect(() => { if (inline) aimAt(undefined); }, [inline, aimAt]);

  /** Whether this page's document has drawn: the resident page notes it in the store, an inline one tells its bubble. */
  const notePainted = useCallback((painted: boolean) => {
    paintedRef.current = painted;
    if (pageKey) extensionViewStore.pagePainted(pageKey, painted);
    if (isInline) {
      setInlinePainted(painted);
      onPaintedRef.current?.(painted);
    }
  }, [pageKey, isInline]);

  const attachWebview = useCallback(
    (element: BrowserWebviewElement | null) => {
      guestTeardownRef.current?.();
      guestTeardownRef.current = null;
      webviewRef.current = element;
      clearTimeout(captureTimerRef.current);
      pendingCaptureRef.current = false;
      guestReadyRef.current = null;
      guestBinding.reset();
      notePainted(false);
      ++aimSeqRef.current;
      if (!element) return;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      let loaded: ReturnType<typeof setTimeout> | undefined;
      let changed: ReturnType<typeof setTimeout> | undefined;
      let frame = 0;
      const painted = () => {
        if (webviewRef.current !== element) return;
        clearTimeout(fallback);
        notePainted(true);
        capture();
      };
      const ready = () => {
        if (webviewRef.current !== element || !element.isConnected) return;
        // Read the id only at this guest's dom-ready, never from a delayed
        // binding reply after Electron has already replaced the guest (#7514).
        guestBinding.ready(element.getWebContentsId());
        guestReadyRef.current = element;
        aimAt(claimOf());
        if (isInline) fallback = setTimeout(painted, 3_000);
      };
      // guest 崩了:旧的 webContents id 作废,绑定也作废。重载一次,dom-ready 会再来一遍、重新 bind;
      // ❌ 不能留着一个死 id 等下一次认领去 retarget —— 那只会换来一条 warn 和一格永远的空白。
      const gone = () => {
        if (webviewRef.current !== element) return;
        log.warn('Extension surface render process gone; reloading', { kind });
        notePainted(false);
        guestReadyRef.current = null;
        guestBinding.reset();
        ++aimSeqRef.current;
        registeredRef.current = null;
        element.reload();
      };
      element.addEventListener('dom-ready', ready);
      element.addEventListener('render-process-gone', gone);
      // Loaded is enough for a widget (its snapshot is waiting); any other page shows at its first contentful paint, or after 3s.
      const load = () => { if (isInline) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { loaded = setTimeout(painted, 500); }); }); };
      element.addEventListener('did-finish-load', load);
      const signal = (event: Event) => {
        const channel = (event as Event & { channel: string }).channel;
        if (channel === 'gugu-page-painted') painted();
        else if (channel === 'gugu-widget-changed') { clearTimeout(changed); changed = setTimeout(capture, 1_000); }
      };
      element.addEventListener('ipc-message', signal);
      // Same reason for Esc: pressed in the guest, it leaves full screen here (tab-fullscreen).
      const escape = (event: Event) => { if ((event as Event & { channel: string }).channel === 'gugu-guest-escape') tabFullscreen.exit(); };
      element.addEventListener('ipc-message', escape);
      // A tab's page is zoomed by the host, remembered per App (zoom B); a widget in a message keeps the chat's size.
      const box = isInline ? null : element.closest<HTMLElement>('[data-extension-view]');
      const offZoom = box ? bindAppPageZoom(box, element, extensionId) : null;
      guestTeardownRef.current = () => {
        offZoom?.();
        element.removeEventListener('dom-ready', ready);
        element.removeEventListener('render-process-gone', gone);
        element.removeEventListener('ipc-message', signal);
        element.removeEventListener('ipc-message', escape);
        element.removeEventListener('did-finish-load', load);
        clearTimeout(fallback); clearTimeout(loaded); clearTimeout(changed);
        if (frame) cancelAnimationFrame(frame);
      };
    },
    [aimAt, claimOf, guestBinding, kind, isInline, extensionId, capture, notePainted]
  );

  // 认领方一换(切会话 / 换 tab / 聊天栏换会话)→ 重新指向 + 重新摆位。
  useLayoutEffect(
    () => isInline ? undefined : reaction(
        () => claimOf(),
        (claim) => aimAt(claim),
        { fireImmediately: true }
      ),
    [aimAt, claimOf, isInline]
  );

  // 摆位与尺寸汇报:跟着认领方那一格走;一格都没有就藏起来。
  useLayoutEffect(
    () => isInline ? undefined : reaction(
        () => claimOf(),
        (claim, previous) => {
          teardownRef.current?.();
          teardownRef.current = null;
          const box = boxRef.current;
          const layer = layerRef.current;
          if (!box || !layer) return;
          if (!claim) {
            releaseHiddenFocus(box, previous);
            box.style.visibility = 'hidden';
            if (managed) box.style.opacity = '0';
            box.inert = true;
            report(false, 0, 0);
            return;
          }
          const place = () => {
            const { full, clip } = boxOf(claim.element, layer);
            const shown =
              clip.width > 0 &&
              clip.height > 0 &&
              claim.element.isConnected &&
              claim.element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
            if (!shown) releaseHiddenFocus(box, claim);
            box.style.left = `${clip.left}px`;
            box.style.top = `${clip.top}px`;
            box.style.width = `${clip.width}px`;
            box.style.height = `${clip.height}px`;
            // Rounded where the place it is put in is rounded (the assistant panel's card): clipped as that place clips.
            Object.assign(box.style, pageCorners(getComputedStyle(claim.element), full, clip));
            box.style.visibility = shown ? 'visible' : 'hidden';
            box.style.zIndex = ancestorsOf(claim.element).some((element) => element.hasAttribute('data-tab-fullscreen'))
              ? 'var(--z-pane-fullscreen-resident)'
              : 'var(--z-pane-resident)';
            if (managed) box.style.opacity = shown ? '1' : '0';
            box.inert = !shown;
            const inner = innerRef.current;
            if (inner) {
              inner.style.left = `${full.left - clip.left}px`;
              inner.style.top = `${full.top - clip.top}px`;
              inner.style.width = `${full.width}px`;
              inner.style.height = `${full.height}px`;
            }
            report(shown && document.visibilityState === 'visible', full.width, full.height);
          };
          place();
          // A slot that slides in (a side panel's enter animation) moves by transform, which no
          // ResizeObserver, resize or scroll reports: measured once, the page stayed drawn where the
          // slot was mid-slide (desktop #6802 D1). So follow it frame by frame until its box has
          // held still for a few frames — bounded, for a slot that never settles.
          let frame = 0;
          const followUntil = performance.now() + FOLLOW_MAX_MS;
          let lastBox = '';
          let still = 0;
          const follow = () => {
            place();
            const r = claim.element.getBoundingClientRect();
            const box = `${r.left},${r.top},${r.width},${r.height}`;
            still = box === lastBox ? still + 1 : 0;
            lastBox = box;
            frame = still < FOLLOW_STILL_FRAMES && performance.now() < followUntil ? requestAnimationFrame(follow) : 0;
          };
          frame = requestAnimationFrame(follow);
          const observer = new ResizeObserver(place);
          // Hidden in place by a class or style above it (a slot covered by what opens beside its page, AppPeekSlot) moves no
          // box: the page is told to hide by the change itself.
          const restyled = new MutationObserver(place);
          for (const node of ancestorsOf(claim.element)) {
            observer.observe(node);
            restyled.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert'] });
          }
          window.addEventListener('resize', place);
          document.addEventListener('scroll', place, true);
          document.addEventListener('visibilitychange', place);
          const stopOcclusion = observeNativeSurfaceOcclusion(place);
          teardownRef.current = () => {
            if (frame) cancelAnimationFrame(frame);
            observer.disconnect();
            restyled.disconnect();
            stopOcclusion();
            window.removeEventListener('resize', place);
            document.removeEventListener('scroll', place, true);
            document.removeEventListener('visibilitychange', place);
          };
        },
        { fireImmediately: true }
      ),
    // surface 进依赖:页的框(boxRef)要等激活之后才渲染出来,而那时认领方可能早就在了 ——
    // 不重订这条反应,它就停在「fireImmediately 那次没框可摆」上,直到下一次切会话才醒。
    [claimOf, layerRef, report, surface, managed, isInline]
  );

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!isInline || !box) return;
    const layout = () => report(document.visibilityState === 'visible', box.clientWidth, box.clientHeight);
    const resize = new ResizeObserver(layout);
    resize.observe(box);
    document.addEventListener('visibilitychange', layout);
    layout();
    // Leaving the reader's view (under half shown), the widget's picture is taken: the bubble shows it once the row goes.
    let seen = false;
    const leaving = new IntersectionObserver(([entry]) => {
      const shown = (entry?.intersectionRatio ?? 0) >= 0.5;
      if (seen && !shown) capture();
      seen = shown;
    }, { threshold: 0.5 });
    leaving.observe(box);
    return () => { resize.disconnect(); leaving.disconnect(); document.removeEventListener('visibilitychange', layout); };
  }, [isInline, surface, report, capture]);

  useEffect(
    () => () => {
      teardownRef.current?.();
      // 常驻页没了(扩展停用 / 卸载 / 最久没用被销毁):它说过的话一起清掉,再开从清单标题重新开始。
      if (pageKey !== undefined) extensionSurfaceStore.forgetShared(pageKey);
    },
    [pageKey]
  );

  // A page stays clear until it has painted: a widget's snapshot shows through, any other page has the loading mark over it.
  const unpainted = !managed && (isInline ? !inlinePainted : !pageKey || !extensionViewStore.paintedPages.has(pageKey));
  // The mark and its fallback start together, when the page is asked for (not at its guest's dom-ready), and end together:
  // a page that never says it painted is shown after three seconds (a widget's waits for its guest, above).
  const marked = unpainted && !!pageKey && !!claimOf();
  useEffect(() => {
    if (!marked) return undefined;
    const fallback = setTimeout(() => extensionViewStore.pagePainted(pageKey!), 3_000);
    return () => clearTimeout(fallback);
  }, [marked, pageKey]);
  // Not started yet, its box is still placed: the loading mark shows from the moment the page is asked for.
  if (!surface && !managed && inline) return null;
  const manifest = installed.state === 'value' ? installed.value.manifestFor(extensionId) : undefined;
  const page = managed && manifest ? <AppSettingsPage key={`${manifest.version}:${JSON.stringify(manifest.settings)}`} manifest={manifest} active={claimOf() !== undefined} /> : surface ? <webview
    key={`${extensionId}:${surface.partition}`}
    ref={attachWebview}
    src={surface.entryUrl}
    partition={surface.partition}
    className={`h-full w-full bg-background ${unpainted ? 'opacity-0' : ''}`}
  /> : null;
  if (inline) return <div ref={boxRef} className={`h-full w-full overflow-hidden ${unpainted ? '' : 'bg-background'}`} data-extension-view={kind} data-widget-message={inline.widget?.messageId}>{page}</div>;
  return (
    <div
      ref={boxRef}
      className={`pointer-events-auto absolute overflow-hidden ${unpainted ? '' : 'bg-background'}`}
      style={{ visibility: 'hidden', opacity: managed ? 0 : undefined, left: 0, top: 0, width: 0, height: 0 }}
      data-extension-view={kind}
      data-extension-item={itemId}
    >
      <div ref={innerRef} className="absolute" style={{ left: 0, top: 0, width: 0, height: 0 }}>
        {page}
      </div>
      {marked ? <PageLoading /> : null}
    </div>
  );
});
