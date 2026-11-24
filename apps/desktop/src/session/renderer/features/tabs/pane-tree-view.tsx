import { useDndContext } from '@dnd-kit/core';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { trackRecentTools } from '../browser/workspace-recent-tools';
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { CutEdgeRelay } from './chat-workspace-edge';

/** `part`: 'all' = the pane's strip over its page; while paired the main pane's 'bar' is drawn above both 'body's. */
type RenderPane = (paneId: string, first: boolean, last: boolean, part: 'all' | 'bar' | 'body') => ReactNode;
const STRIP_OVER_FULLSCREEN = fullscreenCover('anchor(top)', 'auto');
const childId = (node: PaneLayoutNode) => node.type === 'pane' ? `pane-${node.paneId}` : `cut-${node.id}`;

/**
 * Tasks and conversations render the same tree. Narrowing changes visibility, never the saved tree or history.
 * @@@flat-panes - the tree draws only empty, anchored cells; each pane is drawn once, keyed by its id, as a flat
 * sibling pinned to its cell (CSS anchor positioning). Splitting or closing reshapes the tree: a pane drawn inside it
 * would change parents and remount with everything in it. Drawn flat it keeps its identity, so a split costs the same
 * whatever the panes hold.
 */
export const PaneTreeView = observer(function PaneTreeView({ layout, renderPane, chatChrome }: {
  layout: PaneLayoutStore;
  renderPane: RenderPane;
  chatChrome?: ChatWorkspaceChromeProps;
}) {
  const treeId = useId().replace(/[^\w-]/g, '');
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
  const anchorOf = (paneId: string) => `--pane-${treeId}-${paneId}`;
  // @@@single-on-track — the chat workspace's hidden and full views are the root cut at 100 / 0, ❌ the narrow branch (which
  // has no track: the page came and went in one frame). The page it stops showing stays shown, live, until its cell is at
  // nothing (@@@leaving-panes); in full view, the other page coming to the front is a page swap, in one frame.
  const shownBefore = useRef(single);
  const swap = !!shownBefore.current && !!single && shownBefore.current !== single;
  useLayoutEffect(() => { shownBefore.current = single; });
  // Wide, the root cut is on a track: a pane whose last tab closes goes off it before it goes (@@@closing-pane).
  useLayoutEffect(() => narrow ? undefined : layout.attachMotion(), [layout, narrow]);
  const closing = layout.closingPaneId;
  const first = cornerPane(layout.layout, 'top-left');
  const last = cornerPane(layout.layout, 'top-right');
  // 并排(spec session-page「并排」):一条会话只有一条页签条 —— 横跨两页画在上面,两页各自的内容在下面。
  const paired = layout.sidePaneId !== null;
  const lifted = layout.groups.some(({ pane }) => tabFullscreen.isOn(pane));
  const [edge] = useState(() => new CutEdgeRelay());
  return <PaneDimensionProvider sink={layout}>
    {/* What the content surface around it reads (desktop-shell.css): only while this workspace is on screen. A retained page
        hidden under it keeps its own two marks, and the surface took a hidden task's cards for the shown chat's (square corners). */}
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-chat-tool-workspace={scopedChrome ? '' : undefined} data-chat-tool-cards={scopedChrome && layout.chatToolCardPaneId ? '' : undefined}
      data-surface-chat={scopedChrome && workspaceShown ? layout.chatToolCardPaneId ? 'cards' : 'tools' : undefined}>
      {/* A page of the pair in full screen keeps this one strip over it (its exit is on the tab); the row keeps its height, so nothing under it moves. */}
      {scopedChrome && <ChatWorkspaceChrome layout={layout} edge={edge} {...scopedChrome} />}
      {!scopedChrome && paired && <div className="min-w-0 shrink-0" style={{ height: WINDOW_CONTROL_BAR_HEIGHT_PX }} data-pane-strip="">
        <div style={lifted ? STRIP_OVER_FULLSCREEN : undefined}>{renderPane(layout.mainGroup.paneId, true, true, 'bar')}</div>
      </div>}
      {/* The pages are laid over the cut on its anchors (❌ inside the track's clipped boxes): a page sliding in sticks out past
          the edge here. overflow clip, ❌ hidden or visible: what sticks out must not be scrollable overflow, or a page that
          takes focus while still off the edge (the browser's address bar) has the box around it scrolled, and the page beside
          it pushed past its place. */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-clip" data-pane-tree-pages="" data-pane-tree-narrow={alone || undefined} data-chat-tool-dragging={draggingChatTool || undefined}>
        {/* The root is a cut even as one pane, so the side page coming and going moves on its track (going, live: @@@closing-pane). */}
        <Cut node={layout.layout} layout={layout} narrow={narrow} visiblePaneId={visiblePaneId} anchorOf={anchorOf} single={single} swap={swap} edge={scopedChrome ? edge : undefined} />
        {layout.groups.map(({ paneId }) => {
          const shown = layout.isPaneShown(paneId);
          const anchored = { position: 'absolute', positionAnchor: anchorOf(paneId), top: 'anchor(top)', bottom: 'anchor(bottom)', left: 'anchor(left)', right: 'anchor(right)' } as CSSProperties;
          return <RetainedTabContent key={paneId} visible={shown} style={anchored} className="min-h-0 min-w-0" data-chat-tool-card={scopedChrome && paneId === layout.chatToolCardPaneId ? '' : undefined} data-chat-card={scopedChrome && layout.chatToolCardPaneId && paneId === layout.chatWorkspacePanes?.chat.paneId ? '' : undefined} inert={!shown || paneId === closing} aria-hidden={!shown || paneId === closing || undefined}>
            {renderPane(paneId, alone || paneId === first, alone || paneId === last, (scopedChrome || paired) ? 'body' : 'all')}
          </RetainedTabContent>;
        })}
        {draggingChatTool && layout.chatWorkspaceMode === 'full' && <ChatWorkspaceDropZones layout={layout} tabId={String(active.id)} />}
      </div>
    </div>
  </PaneDimensionProvider>;
});

type TreeProps = { node: PaneLayoutNode; layout: PaneLayoutStore; narrow: boolean; visiblePaneId: string; anchorOf: (paneId: string) => string; single?: string; swap?: boolean; edge?: CutEdgeRelay };

const Tree = observer(function Tree({ node, ...rest }: TreeProps) {
  if (node.type === 'pane') return <div className="relative h-full min-h-0 min-w-0" style={{ anchorName: rest.anchorOf(node.paneId) } as CSSProperties} />;
  return <Cut node={node} {...rest} />;
});

const Cut = observer(function Cut({ node, ...rest }: TreeProps) {
  const { layout, narrow, visiblePaneId } = rest;
  const split = node.type === 'split' ? node : { id: '', orientation: 'horizontal' as const, children: [node], sizes: [100] };
  const chatDivider = !narrow && layout.chatWorkspaceMode === 'split' && node === layout.layout && split.orientation === 'horizontal' && split.children.length === 2;
  const divider = useChatWorkspaceDivider(layout, chatDivider ? split.id : undefined);
  const tree = (child: PaneLayoutNode) => <Tree node={child} {...rest} />;
  // Narrow: one pane at a time, each child laid over the whole cut (the others hidden, not unmounted).
  if (narrow) return <div className="relative h-full w-full">
    {split.children.map((child) => {
      const shown = paneOrder(child).includes(visiblePaneId);
      return <div key={childId(child)} className="absolute inset-0 min-h-0 min-w-0" style={{ visibility: shown ? 'visible' : 'hidden', pointerEvents: shown ? undefined : 'none' }} inert={!shown} aria-hidden={!shown || undefined}>{tree(child)}</div>;
    })}
  </div>;
  const horizontal = split.orientation === 'horizontal';
  const root = node === layout.layout;
  // One page of the chat workspace on screen: the other is at nothing on the same track, ❌ unmounted or laid over.
  const only = root ? rest.single : undefined;
  // A pane closing goes to nothing; the rest take its share (@@@closing-pane).
  const closing = root ? layout.closingPaneId : undefined;
  const gone = (child: PaneLayoutNode) => child.type === 'pane' && child.paneId === closing;
  const kept = split.sizes.reduce((sum, size, at) => sum + (gone(split.children[at]) ? 0 : size), 0);
  return <TrackCut
    axis={horizontal ? 'x' : 'y'}
    shares={only ? split.children.map((child) => (paneOrder(child).includes(only) ? 100 : 0)) : closing && kept > 0 ? split.sizes.map((size, at) => (gone(split.children[at]) ? 0 : (size * 100) / kept)) : split.sizes}
    disabled={!!only || !!closing}
    onLanded={root ? () => layout.panesLanded() : undefined}
    onEdge={root && rest.edge ? (at) => rest.edge!.write(at) : undefined}
    items={split.children.map((child) => ({ id: childId(child), min: only || gone(child) ? 0 : horizontal ? minExtent(child, 'width', layout.paneMinWidth) : minExtent(child, 'height', MIN_PANE_HEIGHT_PX), node: tree(child) }))}
    // The outermost cut is the pair's: the side page coming to another width (a tab of another kind in front) moves.
    animate={root && !rest.swap}
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
