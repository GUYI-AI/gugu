import { useDndContext } from '@dnd-kit/core';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { trackRecentTools } from '../browser/workspace-recent-tools';
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FILLS_BOX, SurfaceBox, surfaceHost } from '@renderer/lib/layout/place-in';
import { observer } from 'mobx-react-lite';
import { PaneDimensionProvider } from './pane-dimension-provider';
import { RetainedTabContent } from './retained-tab-content';
import { MIN_PANE_HEIGHT_PX, type PaneLayoutStore } from './pane-layout-store';
import { cornerPane, minExtent, paneOrder, type PaneLayoutNode } from './pane-layout-tree';
import { fullscreenCover, tabFullscreen } from './tab-fullscreen';
import { WINDOW_CONTROL_BAR_HEIGHT_PX } from '@/lib/window-chrome';
import { useChatWorkspaceDivider } from './use-chat-workspace-divider';
import { TrackCut } from './pane-track-cut';
import { ChatWorkspaceDropZones } from './chat-workspace-drop-zones';
import { ChatWorkspaceChrome, type ChatWorkspaceChromeProps } from './chat-workspace-chrome';

/** `part`: 'all' = the pane's strip over its page; while paired the main pane's 'bar' is drawn above both 'body's. */
type RenderPane = (paneId: string, first: boolean, last: boolean, part: 'all' | 'bar' | 'body') => ReactNode;
const STRIP_OVER_FULLSCREEN = fullscreenCover('anchor(top)', 'auto');
const childId = (node: PaneLayoutNode) => node.type === 'pane' ? `pane-${node.paneId}` : `cut-${node.id}`;

/**
 * Tasks and conversations render the same tree. Narrowing changes visibility, never the saved tree or history.
 * @@@flat-panes - the tree draws only empty cells; each pane is rendered once, keyed by its id, into a host of its own
 * that is put in its cell (@@@placed-surface). Splitting or closing reshapes the tree: a pane rendered inside it would
 * change parents and remount with everything in it. Rendered flat it keeps its identity, so a split costs the same
 * whatever the panes hold; put in its cell it is in the cut's boxes, clipped, faded and moved with them.
 */
export const PaneTreeView = observer(function PaneTreeView({ layout, renderPane, chatChrome }: {
  layout: PaneLayoutStore;
  renderPane: RenderPane;
  chatChrome?: ChatWorkspaceChromeProps;
}) {
  const anchor = `--chat-workspace-${useId().replace(/[^\w-]/g, '')}`;
  const withChatChrome = !!chatChrome;
  const workspaceShown = useContext(SurfaceShownContext);
  useEffect(() => withChatChrome && workspaceShown ? trackRecentTools(layout) : undefined, [layout, withChatChrome, workspaceShown]);
  useLayoutEffect(() => withChatChrome ? layout.attachChatWorkspace() : undefined, [layout, withChatChrome]);
  const scopedChrome = chatChrome && layout.chatWorkspaceMode !== undefined ? chatChrome : undefined;
  const single = layout.chatWorkspaceSinglePaneId;
  const { active } = useDndContext();
  const draggingChatTool = !!scopedChrome && !!active && layout.canDropChatToolGroup(String(active.id));
  const narrow = layout.narrow;
  const alone = narrow || !!single;
  const visiblePaneId = single ?? layout.activePaneId;
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const hostOf = (paneId: string) => hosts.current.get(paneId) ?? hosts.current.set(paneId, surfaceHost('contents')).get(paneId)!;
  useLayoutEffect(() => {
    for (const [paneId, host] of hosts.current) if (!layout.groups.some((group) => group.paneId === paneId)) { host.remove(); hosts.current.delete(paneId); }
  });
  const pagesRef = useRef<HTMLDivElement>(null);
  // The chat workspace's strip, a host per column: wide, each heads its pane's cell (@@@strip-in-cells); in full view and narrow, the row above.
  const [heads] = useState(() => ({ chat: surfaceHost('contents'), tools: surfaceHost('contents') }));
  const headPark = useRef<HTMLSpanElement>(null);
  // @@@single-on-track — the chat workspace's hidden and full views, and the narrow layout, are the cuts at 100 / 0. The
  // page a move stops showing stays shown, live, until its cell is at nothing (@@@leaving-panes); in full view the other
  // page coming to the front, and the layout going narrow or wide, are page swaps, in one frame.
  const before = useRef({ single, narrow });
  const swap = (!!before.current.single && !!single && before.current.single !== single) || before.current.narrow !== narrow;
  useLayoutEffect(() => { before.current = { single, narrow }; });
  // Wide, the root cut is on a track: a pane whose last tab closes goes off it before it goes (@@@closing-pane).
  useLayoutEffect(() => narrow ? undefined : layout.attachMotion(), [layout, narrow]);
  const closing = layout.closingPaneId;
  const first = cornerPane(layout.layout, 'top-left');
  const last = cornerPane(layout.layout, 'top-right');
  // 并排(spec session-page「并排」):一条会话只有一条页签条 —— 横跨两页画在上面,两页各自的内容在下面。
  const paired = layout.sidePaneId !== null;
  const lifted = layout.groups.some(({ pane }) => tabFullscreen.isOn(pane));
  const headsInCells = !!scopedChrome && !narrow && layout.chatWorkspaceMode !== 'full';
  const headOf = (paneId: string) => paneId === layout.chatWorkspacePanes?.chat.paneId ? heads.chat : paneId === layout.chatWorkspacePanes?.tools?.paneId ? heads.tools : undefined;
  return <PaneDimensionProvider sink={layout} atRest>
    {/* What the content surface around it reads (desktop-shell.css): only while this workspace is on screen. A retained page
        hidden under it keeps its own two marks, and the surface took a hidden task's cards for the shown chat's (square corners). */}
    <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ anchorName: anchor } as CSSProperties} data-chat-tool-workspace={scopedChrome ? '' : undefined} data-chat-tool-cards={scopedChrome && layout.chatToolCardPaneId ? '' : undefined}
      data-surface-chat={scopedChrome && workspaceShown ? layout.chatToolCardPaneId ? 'cards' : 'tools' : undefined}>
      {/* A page of the pair in full screen keeps this one strip over it (its exit is on the tab); the row keeps its height, so nothing under it moves. */}
      {scopedChrome && <span ref={headPark} hidden />}
      {scopedChrome && <ChatWorkspaceChrome layout={layout} heads={heads} inCells={headsInCells} park={headPark} anchor={anchor} {...scopedChrome} />}
      {!scopedChrome && paired && <div className="min-w-0 shrink-0" style={{ height: WINDOW_CONTROL_BAR_HEIGHT_PX }} data-pane-strip="">
        <div style={lifted ? STRIP_OVER_FULLSCREEN : undefined}>{renderPane(layout.mainGroup.paneId, true, true, 'bar')}</div>
      </div>}
      <div ref={pagesRef} className="relative min-h-0 min-w-0 flex-1" data-pane-tree-pages="" data-pane-tree-narrow={alone || undefined} data-chat-tool-dragging={draggingChatTool || undefined}>
        {/* The root is a cut even as one pane, so the side page coming and going moves on its track (going, live: @@@closing-pane). */}
        <Cut node={layout.layout} layout={layout} narrow={narrow} visiblePaneId={visiblePaneId} hostOf={hostOf} park={pagesRef} headPark={headPark} single={single} swap={swap} headOf={headsInCells ? headOf : undefined} />
        {layout.groups.map(({ paneId }) => {
          const shown = layout.isPaneShown(paneId);
          return createPortal(<RetainedTabContent visible={shown} style={FILLS_BOX} className="min-h-0 min-w-0" data-chat-tool-card={scopedChrome && paneId === layout.chatToolCardPaneId ? '' : undefined} data-chat-card={scopedChrome && layout.chatToolCardPaneId && paneId === layout.chatWorkspacePanes?.chat.paneId ? '' : undefined} inert={!shown || paneId === closing} aria-hidden={!shown || paneId === closing || undefined}>
            {renderPane(paneId, alone || paneId === first, alone || paneId === last, (scopedChrome || paired) ? 'body' : 'all')}
          </RetainedTabContent>, hostOf(paneId), paneId);
        })}
        {draggingChatTool && layout.chatWorkspaceMode === 'full' && <ChatWorkspaceDropZones layout={layout} tabId={String(active.id)} />}
      </div>
    </div>
  </PaneDimensionProvider>;
});

type TreeProps = { node: PaneLayoutNode; layout: PaneLayoutStore; narrow: boolean; visiblePaneId: string; hostOf: (paneId: string) => HTMLElement; park: React.RefObject<HTMLElement | null>; headPark: React.RefObject<HTMLElement | null>; single?: string; swap?: boolean; headOf?: (paneId: string) => HTMLElement | undefined };

const Tree = observer(function Tree({ node, ...rest }: TreeProps) {
  if (node.type !== 'pane') return <Cut node={node} {...rest} />;
  const head = rest.headOf?.(node.paneId);
  const { layout, park } = rest;
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    {head && <SurfaceBox host={head} park={rest.headPark} className="relative flex min-w-0 shrink-0" data-chat-workspace-header={layout.chatWorkspaceMode} data-chat-tool-cards={layout.chatToolCardPaneId ? '' : undefined} />}
    <SurfaceBox host={rest.hostOf(node.paneId)} park={park} className="relative min-h-0 min-w-0 flex-1" />
  </div>;
});

const Cut = observer(function Cut({ node, ...rest }: TreeProps) {
  const { layout, narrow, visiblePaneId } = rest;
  const split = node.type === 'split' ? node : { id: '', orientation: 'horizontal' as const, children: [node], sizes: [100] };
  const chatDivider = !narrow && layout.chatWorkspaceMode === 'split' && node === layout.layout && split.orientation === 'horizontal' && split.children.length === 2;
  const divider = useChatWorkspaceDivider(layout, chatDivider ? split.id : undefined);
  const tree = (child: PaneLayoutNode) => <Tree node={child} {...rest} />;
  const horizontal = split.orientation === 'horizontal';
  const root = node === layout.layout;
  // One page on screen (narrow, at every cut; the chat workspace's hidden and full views): the others are at nothing, in the same cells.
  const only = narrow ? visiblePaneId : root ? rest.single : undefined;
  // A pane closing goes to nothing; the rest take its share (@@@closing-pane).
  const closing = root ? layout.closingPaneId : undefined;
  const gone = (child: PaneLayoutNode) => child.type === 'pane' && child.paneId === closing;
  const kept = split.sizes.reduce((sum, size, at) => sum + (gone(split.children[at]) ? 0 : size), 0);
  return <TrackCut
    axis={horizontal ? 'x' : 'y'}
    shares={only ? split.children.map((child) => (paneOrder(child).includes(only) ? 100 : 0)) : closing && kept > 0 ? split.sizes.map((size, at) => (gone(split.children[at]) ? 0 : (size * 100) / kept)) : split.sizes}
    disabled={!!only || !!closing}
    onLanded={root ? () => layout.panesLanded() : undefined}
    items={split.children.map((child) => ({ id: childId(child), min: only || gone(child) ? 0 : horizontal ? minExtent(child, 'width', layout.paneMinWidth) : minExtent(child, 'height', MIN_PANE_HEIGHT_PX), node: tree(child) }))}
    // The outermost cut is the pair's: the side page coming to another width (a tab of another kind in front) moves.
    animate={root && !rest.swap && !narrow}
    onShares={(sizes) => layout.setSplitSizes(split.id, sizes)}
    onEqualize={() => layout.equalizeSplit(split.id)}
    divider={chatDivider ? { at: 0, ref: divider.handleRef, onPointerDown: divider.start, props: { 'data-chat-tool-divider': '' } } : undefined}
  >
    {chatDivider && divider.preview && <div
      className={`pointer-events-none absolute inset-y-0 border-foreground/25 bg-foreground/10 ${divider.preview === 'left' ? 'left-0 border-r' : 'right-0 border-l'}`}
      style={{ zIndex: 'var(--z-pane-divider)', width: `${split.sizes[divider.preview === 'left' ? 0 : 1]}%` }}
      data-occludes-browser-page
      data-chat-tool-collapse-preview={divider.preview}
      data-chat-tool-collapse-ready={divider.ready || undefined}
    />}
  </TrackCut>;
});
