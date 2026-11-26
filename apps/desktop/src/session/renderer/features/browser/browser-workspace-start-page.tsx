import type { ReactNode } from 'react';
import { Globe, Plus, X } from '@/lib/icons';
import { FileMark } from '@gugu/session-ui/file-mark';
import { TabKindMark } from '../extensions/extension-mark';
import { WORKSPACE_APP_KIND } from '../chats/chat-tabs/chat-panel-item';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TabViewContext } from '../tabs/core/tab-provider';
import { recentToolPanel, useRecentTools, type RecentTool } from './workspace-recent-tools';
import { useShortcutTitle, type WorkspacePanelAction } from '../sessions/pane-empty-state';
import { openAppsLocation } from '@renderer/features/apps/apps-location';

type WorkspaceRecentItem = {
  id: string;
  title: string;
  kind: 'web' | 'file' | 'folder';
  open: () => void;
  remove: () => void;
};

export function BrowserWorkspaceStartPage({ actions, recent }: {
  actions: readonly WorkspacePanelAction[];
  recent: readonly WorkspaceRecentItem[];
}) {
  const { translate } = useSessionMessages();
  const shortcutTitle = useShortcutTitle();
  // Built-ins first, then Apps, then the door to add one: one row of tiles, the same tile as Recent.
  const ordered = [...actions.filter((item) => item.section !== 'extensions'), ...actions.filter((item) => item.section === 'extensions')];
  return (
    <div className="h-full overflow-auto bg-tab-face px-6 py-8 [container-type:inline-size]" data-workspace-new-tab-page="">
      <div className="mx-auto flex max-w-[720px] flex-col gap-9">
        <div className={START_TILE_GRID}>
          {ordered.map((item) => <StartTile key={item.id} icon={item.icon} label={item.label} disabled={item.disabled}
            title={shortcutTitle(item.title ?? item.label, item.shortcutSettingsKey)} onClick={item.onClick} corner={item.trailing} />)}
          <StartTile icon={<Plus className="size-3.5" />} label={translate('browser.workspaceAddApp')} onClick={() => openAppsLocation({ tab: 'market' })} />
        </div>
        <section aria-label={translate('browser.workspaceRecent')} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">{translate('browser.workspaceRecent')}</h2>
          {recent.length ? <div className={START_TILE_GRID}>
            {recent.slice(0, 4).map((item) => {
              const remove = translate('browser.workspaceRemoveRecent', { label: item.title });
              return <StartTile key={item.id} label={item.title} title={item.title} onClick={item.open}
                icon={item.kind === 'web' ? <Globe className="size-7" /> : item.kind === 'folder' ? <TabKindMark kind={WORKSPACE_APP_KIND} /> : <FileMark name={item.title} className="size-7" />}
                corner={<Button size="icon-xs" variant="ghost" aria-label={remove} title={remove} onClick={item.remove}><X className="size-3" /></Button>} />;
            })}
          </div> : <p className="text-sm text-foreground-muted">{translate('browser.workspaceRecentEmpty')}</p>}
        </section>
      </div>
    </div>
  );
}

export const START_TILE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2';

/** The start pages' one tile: icon over name. `corner` is a control that shows on hover, e.g. remove from Recent. */
export function StartTile({ icon, label, title, disabled, onClick, corner }: {
  icon: ReactNode;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  corner?: ReactNode;
}) {
  return <div className="group/tile relative min-w-0 rounded-md hover:bg-row-hover focus-within:bg-row-hover">
    <Button variant="ghost" className="h-22 w-full flex-col gap-2 px-2 text-foreground hover:bg-transparent"
      title={title} disabled={disabled} onClick={onClick}>
      {/* Action icons arrive sized for a row (size-3.5); the tile draws every one at the Recent size. An svg with no
          size class is the Button's (size-4, the more specific rule): an icon drawn here says its size. */}
      <span className="flex size-7 items-center justify-center [&_:is(svg,img,span)]:size-7">{icon}</span>
      <span className="w-full truncate text-center text-xs">{label}</span>
    </Button>
    {corner && <span className="absolute top-1 right-1 opacity-0 group-hover/tile:opacity-100 group-focus-within/tile:opacity-100">{corner}</span>}
  </div>;
}

const toolsOrder = ['files', 'side-session', 'review', 'terminal', 'ports'];

export type BrowserWorkspaceStart = {
  ctx: TabViewContext;
  openRecent: (entry: Exclude<RecentTool, { kind: 'web' }>) => void;
};

export function BrowserWorkspaceStartContent({ config, actions, onOpenUrl }: {
  config: BrowserWorkspaceStart;
  actions: WorkspacePanelAction[];
  onOpenUrl: (url: string) => void;
}) {
  const { translate } = useSessionMessages();
  const { items, remove } = useRecentTools(recentToolPanel(config.ctx));
  const rank = (action: WorkspacePanelAction) => {
    const position = toolsOrder.indexOf(action.id);
    return position < 0 ? toolsOrder.length : position;
  };
  // The page is the browser already: its address bar is right above, so no tile opens one (界面减法, yangchichi).
  const ordered = actions.filter((action) => action.id !== 'browser').sort((a, b) => rank(a) - rank(b));
  const recent = items.map((item): WorkspaceRecentItem => ({
    id: item.id,
    title: item.title || translate('workspace.files'),
    kind: item.kind === 'chat-file' ? 'file' : item.kind,
    open: () => item.kind === 'web' ? onOpenUrl(item.url) : config.openRecent(item),
    remove: () => remove(item.id),
  }));
  return <BrowserWorkspaceStartPage actions={ordered} recent={recent} />;
}
