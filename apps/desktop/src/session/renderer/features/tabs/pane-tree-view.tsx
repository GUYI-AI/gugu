import { useDndContext } from '@dnd-kit/core';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { trackRecentTools } from '../browser/workspace-recent-tools';
import { useContext, useEffect, useId, useLayoutEffect, type CSSProperties, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { PaneDimensionProvider } from './pane-dimension-provider';
import { RetainedTabContent } from './retained-tab-content';
import { MIN_PANE_HEIGHT_PX, type PaneLayoutStore } from './pane-layout-store';
import { cornerPane, minExtent, paneOrder, type PaneLayoutNode } from './pane-layout-tree';
import { fullscreenCover, OverFullscreenStrip, tabFullscreen } from './tab-fullscreen';
import { WINDOW_CONTROL_BAR_HEIGHT_PX } from '@/lib/window-chrome';
import { useChatWorkspaceDivider } from './use-chat-workspace-divider';
import { TrackCut } from './pane-track-cut';
import { ChatWorkspaceDropZones } from './chat-workspace-drop-zones';
import { ChatWorkspaceChrome, type ChatWorkspaceChromeProps } from './chat-workspace-chrome';
import { MessageSquare } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

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
  const { translate } = useSessionMessages();
  const withChatChrome = !!chatChrome;
  const workspaceShown = useContext(SurfaceShownContext);
  useEffect(() => withChatChrome && workspaceShown ? trackRecentTools(layout) : undefined, [layout, withChatChrome, workspaceShown]);
  useLayoutEffect(() => withChatChrome ? layout.attachChatWorkspace() : undefined, [layout, withChatChrome]);
  const scopedChrome = chatChrome && layout.chatWorkspaceMode !== undefined ? chatChrome : undefined;
  const single = layout.chatWorkspaceSinglePaneId;
  const { active } = useDndContext();
  const draggingChatTool = !!scopedChrome && !!active && layout.canDropChatToolGroup(String(active.id));
  const narrow = layout.narrow || !!single;
  const visiblePaneId = single ?? layout.activePaneId;
  const first = cornerPane(layout.layout, 'top-left');
  const last = cornerPane(layout.layout, 'top-right');
  const anchorOf = (paneId: string) => `--pane-${treeId}-${paneId}`;
  // 并排(spec session-page「并排」):一条会话只有一条页签条 —— 横跨两页画在上面,两页各自的内容在下面。
  const paired = layout.sidePaneId !== null;
  const lifted = layout.groups.some(({ pane }) => tabFullscreen.isOn(pane));
  return <PaneDimensionProvider sink={layout}>
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-chat-tool-workspace={scopedChrome ? '' : undefined}>
      {/* A page of the pair in full screen keeps this one strip over it (its exit is on the tab); the row keeps its height, so nothing under it moves. */}
      {scopedChrome && <ChatWorkspaceChrome layout={layout} {...scopedChrome} />}
      {!scopedChrome && paired && <div className="min-w-0 shrink-0" style={{ height: WINDOW_CONTROL_BAR_HEIGHT_PX }} data-pane-strip="">
        <div style={lifted ? STRIP_OVER_FULLSCREEN : undefined}><OverFullscreenStrip.Provider value={lifted}>{renderPane(layout.mainGroup.paneId, true, true, 'bar')}</OverFullscreenStrip.Provider></div>
      </div>}
      <div className="relative min-h-0 min-w-0 flex-1" data-pane-tree-narrow={narrow || undefined} data-chat-tool-dragging={draggingChatTool || undefined}>
        <Tree node={layout.layout} layout={layout} narrow={narrow} visiblePaneId={visiblePaneId} anchorOf={anchorOf} />
        {layout.groups.map(({ paneId }) => {
          const shown = !narrow || paneId === visiblePaneId;
          const anchored = { position: 'absolute', positionAnchor: anchorOf(paneId), top: 'anchor(top)', bottom: 'anchor(bottom)', left: 'anchor(left)', right: 'anchor(right)' } as CSSProperties;
          return <RetainedTabContent key={paneId} visible={shown} style={anchored} className="min-h-0 min-w-0" inert={!shown} aria-hidden={!shown || undefined}>
            {renderPane(paneId, narrow || paneId === first, narrow || paneId === last, (scopedChrome || paired) ? 'body' : 'all')}
          </RetainedTabContent>;
        })}
        {draggingChatTool && layout.chatWorkspaceMode === 'full' && <ChatWorkspaceDropZones layout={layout} tabId={String(active.id)} />}
        {scopedChrome && layout.chatWorkspaceConversationPresentation === 'bubble' && <Button
          variant="secondary" className="absolute bottom-3 left-3 z-30 gap-2"
          style={{ minWidth: 44, minHeight: 44, height: 44, paddingInline: 12 }}
          data-testid="chat-workspace-bubble" data-occludes-browser-page
          aria-label={translate('tabs.returnToChat')} title={translate('tabs.returnToChat')}
          onClick={() => layout.showChatWorkspaceConversation()}>
          <MessageSquare className="size-4" />{translate('tabs.returnToChat')}
        </Button>}
      </div>
    </div>
  </PaneDimensionProvider>;
});

const Tree = observer(function Tree({ node, layout, narrow, visiblePaneId, anchorOf }: {
  node: PaneLayoutNode; layout: PaneLayoutStore; narrow: boolean; visiblePaneId: string; anchorOf: (paneId: string) => string;
}) {
  if (node.type === 'pane') return <div className="h-full min-h-0 min-w-0" style={{ anchorName: anchorOf(node.paneId) } as CSSProperties} />;
  return <Cut node={node} layout={layout} narrow={narrow} visiblePaneId={visiblePaneId} anchorOf={anchorOf} />;
});

const Cut = observer(function Cut({ node, layout, narrow, visiblePaneId, anchorOf }: {
  node: Extract<PaneLayoutNode, { type: 'split' }>; layout: PaneLayoutStore; narrow: boolean; visiblePaneId: string; anchorOf: (paneId: string) => string;
}) {
  const chatDivider = !narrow && layout.chatWorkspaceMode === 'split' && node === layout.layout && node.orientation === 'horizontal' && node.children.length === 2;
  const divider = useChatWorkspaceDivider(layout, chatDivider ? node.id : undefined);
  const tree = (child: PaneLayoutNode) => <Tree node={child} layout={layout} narrow={narrow} visiblePaneId={visiblePaneId} anchorOf={anchorOf} />;
  // Narrow: one pane at a time, each child laid over the whole cut (the others hidden, not unmounted).
  if (narrow) return <div className="relative h-full w-full">
    {node.children.map((child) => {
      const shown = paneOrder(child).includes(visiblePaneId);
      return <div key={childId(child)} className="absolute inset-0 min-h-0 min-w-0" style={{ visibility: shown ? 'visible' : 'hidden', pointerEvents: shown ? undefined : 'none' }} inert={!shown} aria-hidden={!shown || undefined}>{tree(child)}</div>;
    })}
  </div>;
  const horizontal = node.orientation === 'horizontal';
  return <TrackCut
    axis={horizontal ? 'x' : 'y'}
    shares={node.sizes}
    items={node.children.map((child) => ({ id: childId(child), min: horizontal ? minExtent(child, 'width', layout.paneMinWidth) : minExtent(child, 'height', MIN_PANE_HEIGHT_PX), node: tree(child) }))}
    // The outermost cut is the pair's: the side page coming to another width (a tab of another kind in front) moves.
    animate={node === layout.layout}
    onShares={(sizes) => layout.setSplitSizes(node.id, sizes)}
    onEqualize={() => layout.equalizeSplit(node.id)}
    divider={chatDivider ? { at: 0, ref: divider.handleRef, onPointerDown: divider.start, props: { 'data-chat-tool-divider': '' } } : undefined}
  >
    {chatDivider && divider.preview && <div
      className={`pointer-events-none absolute inset-y-0 border-foreground/25 bg-foreground/10 ${divider.preview === 'left' ? 'left-0 border-r' : 'right-0 border-l'}`}
      style={{ zIndex: 'var(--z-pane-divider)', width: `${node.sizes[divider.preview === 'left' ? 0 : 1]}%` }}
      data-occludes-browser-page
      data-chat-tool-collapse-preview={divider.preview}
      data-chat-tool-collapse-ready={divider.ready || undefined}
    />}
  </TrackCut>;
});
