import { Folder, Globe, Plus, X } from '@/lib/icons';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TabViewContext } from '../tabs/core/tab-provider';
import { recentToolPanel, useRecentTools, type RecentTool } from './workspace-recent-tools';
import { PaneEmptyStateAction, useShortcutTitle, type WorkspacePanelAction, type WorkspacePanelSection } from '../sessions/pane-empty-state';
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
  const sectionLabels: Record<WorkspacePanelSection, string> = {
    builtin: translate('browser.workspaceBuiltins'),
    extensions: translate('extensions.appsSection'),
  };
  return (
    <div className="h-full overflow-auto bg-tab-strip px-6 py-8 [container-type:inline-size]" data-workspace-new-tab-page="">
      <div className="mx-auto flex max-w-[960px] flex-col gap-9">
        {(['builtin', 'extensions'] as const).map((section) => <section key={section}
          aria-label={sectionLabels[section]} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">{sectionLabels[section]}</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-2">
            {actions.filter((item) => (item.section ?? 'builtin') === section).map((item) => <div key={item.id} className="relative min-w-0">
              <PaneEmptyStateAction icon={item.icon} label={item.label} disabled={item.disabled}
                title={shortcutTitle(item.title ?? item.label, item.shortcutSettingsKey)} onClick={item.onClick}
                className={`border border-border bg-background text-foreground ${item.trailing ? 'pr-9' : ''}`} />
              {item.trailing && <span className="absolute inset-y-0 right-1 flex items-center">{item.trailing}</span>}
            </div>)}
            {section === 'extensions' && <PaneEmptyStateAction icon={<Plus className="size-3.5" />} label={translate('browser.workspaceAddApp')}
              onClick={() => openAppsLocation({ tab: 'market' })} className="border border-border bg-background" />}
          </div>
        </section>)}
        <section aria-label={translate('browser.workspaceRecent')} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">{translate('browser.workspaceRecent')}</h2>
          {recent.length ? <div className="grid grid-cols-4 gap-2 @max-[420px]:grid-cols-2">
            {recent.slice(0, 4).map((item) => {
              const remove = translate('browser.workspaceRemoveRecent', { label: item.title });
              return <div key={item.id} className="group/recent relative min-w-0 rounded-md hover:bg-row-hover focus-within:bg-row-hover">
                <Button variant="ghost" className="h-22 w-full flex-col gap-2 px-2 text-foreground hover:bg-transparent"
                  title={item.title} onClick={item.open}>
                  {item.kind === 'web' ? <Globe className="size-7" /> : item.kind === 'folder' ? <Folder className="size-7" /> : <FileIcon filename={item.title} size={28} className="size-7" />}
                  <span className="w-full truncate text-center text-xs">{item.title}</span>
                </Button>
                <Button size="icon-xs" variant="ghost" aria-label={remove} title={remove} onClick={item.remove}
                  className="absolute top-1 right-1 opacity-0 group-hover/recent:opacity-100 group-focus-within/recent:opacity-100">
                  <X className="size-3" />
                </Button>
              </div>;
            })}
          </div> : <p className="text-sm text-foreground-muted">{translate('browser.workspaceRecentEmpty')}</p>}
        </section>
      </div>
    </div>
  );
}

const toolsOrder = ['files', 'side-session', 'review', 'terminal', 'browser', 'ports'];

export type BrowserWorkspaceStart = {
  ctx: TabViewContext;
  openRecent: (entry: Exclude<RecentTool, { kind: 'web' }>) => void;
};

export function BrowserWorkspaceStartContent({ config, actions, onOpenUrl, onFocusUrl }: {
  config: BrowserWorkspaceStart;
  actions: WorkspacePanelAction[];
  onOpenUrl: (url: string) => void;
  onFocusUrl: () => void;
}) {
  const { translate } = useSessionMessages();
  const { items, remove } = useRecentTools(recentToolPanel(config.ctx));
  const rank = (action: WorkspacePanelAction) => {
    const position = toolsOrder.indexOf(action.id);
    return position < 0 ? toolsOrder.length : position;
  };
  const ordered = [...actions].sort((a, b) => rank(a) - rank(b))
    .map((action) => action.id === 'browser' ? { ...action, onClick: onFocusUrl } : action);
  const recent = items.map((item): WorkspaceRecentItem => ({
    id: item.id,
    title: item.title || translate('workspace.files'),
    kind: item.kind === 'chat-file' ? 'file' : item.kind,
    open: () => item.kind === 'web' ? onOpenUrl(item.url) : config.openRecent(item),
    remove: () => remove(item.id),
  }));
  return <BrowserWorkspaceStartPage actions={ordered} recent={recent} />;
}
