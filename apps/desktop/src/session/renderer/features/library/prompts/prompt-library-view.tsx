import { observer } from 'mobx-react-lite';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { EyeOff, Pencil, Plus, RotateCcw, Trash2, type IconComponent } from '@/lib/icons';
import { useMemo, useRef, useState } from 'react';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { MultiLineListItem } from '@renderer/lib/components/multi-line-list-item';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageLoading } from '@renderer/lib/components/page-layout';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { APP_PROMPT_ACTIONS } from '@shared/prompt-library';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { usePromptLibraryActions, type AppPromptRow, type PromptLibraryActions } from './use-prompt-library-actions';

type PromptListItem = { title: string; prompt: string } | AppPromptRow;

function matchesSearch(item: PromptListItem, search: string) {
  if (!search) return true;
  const haystack = `${item.title} ${item.prompt}`.toLowerCase();
  return haystack.includes(search.toLowerCase());
}

type RowAction = { icon: IconComponent; label: string; word?: string; onClick: () => void };

function PromptRow({
  item,
  disabled,
  tag,
  onEdit,
  actions,
  actionsShown = false,
}: {
  item: PromptListItem;
  disabled: boolean;
  /** 「已修改」/「已隐藏」 on an App's prompt; a hidden one is drawn muted. */
  tag?: string;
  /** Absent: the row's text opens nothing (a hidden App prompt). */
  onEdit?: () => void;
  actions: RowAction[];
  /** On a settings page the actions are there to be found, not on hover. */
  actionsShown?: boolean;
}) {
  return (
    <div className="flex w-full">
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onEdit}
        disabled={disabled || !onEdit}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('text-md truncate', 'state' in item && item.state === 'hidden' ? 'text-foreground-muted' : 'text-foreground')}>{item.title}</span>
          {tag && <span className="shrink-0 rounded border border-border px-1 text-xs text-foreground-muted">{tag}</span>}
        </div>
        <div className="mt-1 line-clamp-1 text-xs leading-relaxed text-foreground-muted">
          {item.prompt}
        </div>
      </button>
      <div className={cn('flex shrink-0 items-center gap-1', !actionsShown && 'opacity-100 sm:opacity-0 sm:transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100')}>
        {actions.map(({ icon: Icon, label, word, onClick }) => actionsShown ? (
          <Button key={label} variant="outline" size="sm" onClick={onClick} disabled={disabled} aria-label={label}>{word ?? label}</Button>
        ) : (
          <Button key={label} variant="ghost" size="icon-xs" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
            <Icon />
          </Button>
        ))}
      </div>
    </div>
  );
}

/** An App's prompt: edit the person's own version, hide it, or go back to the App's. One row for the library page and the App's settings page. */
export function AppPromptListRow({ prompt, actions, disabled }: { prompt: AppPromptRow; actions: PromptLibraryActions; disabled: boolean }) {
  return <MultiLineListItem className="py-3"><AppPromptBody prompt={prompt} actions={actions} disabled={disabled} /></MultiLineListItem>;
}

function AppPromptBody({ prompt, actions, disabled, actionsShown }: { prompt: AppPromptRow; actions: PromptLibraryActions; disabled: boolean; actionsShown?: boolean }) {
  const { translate } = useSessionMessages();
  const offered = APP_PROMPT_ACTIONS[prompt.state];
  const all = {
    edit: { icon: Pencil, label: translate('prompts.editLabel', { title: prompt.title }), word: translate('extensions.manageEdit'), onClick: () => actions.editAppPrompt(prompt) },
    hide: { icon: EyeOff, label: translate('prompts.hide'), word: translate('prompts.hide'), onClick: () => actions.hideAppPrompt(prompt) },
    restore: { icon: RotateCcw, label: translate('prompts.restore'), word: translate('prompts.restore'), onClick: () => actions.restoreAppPrompt(prompt) },
  };
  return (
    <PromptRow item={prompt} disabled={disabled} tag={prompt.state === 'modified' ? translate('prompts.modified') : prompt.state === 'hidden' ? translate('prompts.hidden') : undefined}
        onEdit={offered.includes('edit') ? all.edit.onClick : undefined} actions={offered.map((action) => all[action])} actionsShown={actionsShown} />
  );
}

/** One App's prompts, on its settings page. Same data and writes as the library page. */
export const AppPromptsSection = observer(function AppPromptsSection({ extensionId, store }: { extensionId: string; store: Pick<typeof installedExtensionsStore, 'appPrompts'> }) {
  const actions = usePromptLibraryActions(store);
  return <>{actions.appPrompts.filter((prompt) => prompt.key.startsWith(`${extensionId}/`)).map((prompt) => <div className="mg-row" key={prompt.key}><AppPromptBody prompt={prompt} actions={actions} disabled={actions.isBusy} actionsShown /></div>)}</>;
});

/** Sections like the composer's `/` (prompt-slash-items.ts): the person's own, then each enabled App's. */
export const PromptLibraryView = observer(function PromptLibraryView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => !!element && !!rootRef.current?.contains(element),
    getCommands: () => [{ id: 'app.find', hideFromPalette: true, execute: () => searchRef.current?.focus() }],
  });

  const actions = usePromptLibraryActions();
  const { prompts: promptLibrary, createPrompt, editPrompt, deletePrompt } = actions;
  const { translate } = useSessionMessages();
  // 提示词是账号的(use-prompt-library.ts):资源库选了哪台机器都是这一份,没有「那台机器离线」这回事。
  const isDisabled = actions.isBusy;
  const [search, setSearch] = useState('');

  const filteredItems = useMemo(
    () => promptLibrary.filter((item) => matchesSearch(item, search.trim())),
    [promptLibrary, search]
  );
  const appSections = new Map<string, AppPromptRow[]>();
  for (const item of actions.appPrompts.filter((prompt) => matchesSearch(prompt, search.trim()))) appSections.set(item.appName, [...(appSections.get(item.appName) ?? []), item]);
  return (
    <div ref={rootRef} className="flex flex-col text-foreground">
      <PageHeader
        sticky
        title={translate('prompts.title')}
      >
        <div className="flex w-full justify-between gap-2">
          <SearchInput
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={translate('prompts.searchPlaceholder')}
          />
          <Button
            onClick={createPrompt}
            disabled={isDisabled}
            aria-label={translate('prompts.new')}
          >
            <Plus className="size-4" />
            <span className="[@container(max-width:520px)]:hidden">{translate('prompts.new')}</span>
          </Button>
        </div>
      </PageHeader>
      {!!actions.error && !actions.hasData && (
        <DeviceScopeNoticeLine notice={{ kind: 'failed', text: translate('prompts.loadFailed'), retry: true, readOnly: false, inHeading: false, cached: false }} onRetry={actions.reload} />
      )}
      {/* 还没读到(在读 / 读不到):❌ 先画一句「还没有提示词」冒充它是空的。读不到时上面那一句说清楚。 */}
      {actions.isLoading ? (
        <PageLoading />
      ) : !actions.hasData ? null : (
        <div className={cn('flex flex-col py-2', filteredItems.length === 0 && appSections.size === 0 && 'min-h-64')}>
          {filteredItems.length > 0 || appSections.size > 0 ? (
            <>
              <div className="px-3 pt-2 text-xs text-foreground-muted">{translate('chat.prompts')}</div>
              {filteredItems.map((prompt) => (
                <MultiLineListItem key={prompt.id} className="py-3">
                  <PromptRow
                    item={prompt}
                    disabled={isDisabled}
                    onEdit={() => editPrompt(prompt)}
                    actions={[
                      { icon: Pencil, label: translate('prompts.editLabel', { title: prompt.title }), onClick: () => editPrompt(prompt) },
                      { icon: Trash2, label: translate('prompts.deleteLabel', { title: prompt.title }), onClick: () => deletePrompt(prompt) },
                    ]}
                  />
                </MultiLineListItem>
              ))}
              {[...appSections].map(([app, prompts]) => (
                <div key={app}>
                  <div className="px-3 pt-4 text-xs text-foreground-muted">{app}</div>
                  {prompts.map((prompt) => <AppPromptListRow key={prompt.key} prompt={prompt} actions={actions} disabled={isDisabled} />)}
                </div>
              ))}
            </>
          ) : (
            <EmptyState
              label={translate('prompts.empty')}
              description={search ? translate('prompts.searchEmpty') : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
});
