import { useCallback, useEffect, useMemo, type RefObject } from 'react';
import { useObserver } from 'mobx-react-lite';
import { GUGU_CLIENT_COMMAND_MCP } from '@gugu/session-core/acp/commands';
import type { CommandItem, ContextMentionProvider, MentionItem, PromptEditorRef } from '@gugu/session-ui/react/components';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { useConnectedIssueProviders } from '@renderer/features/integrations/use-connected-issue-providers';
import { promptSlashItems } from '@renderer/features/library/prompts/prompt-slash-items';
import type { usePromptLibrary } from '@renderer/features/library/prompts/use-prompt-library';
import { asMounted, getProjectStore, getProjectViewStore } from '@renderer/features/projects/stores/project-selectors';
import { asProvisioned, getRegisteredSessionData, getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { nudgeWorkspace } from '@renderer/features/sessions/stores/workspace-nudges';
import {
  chatMentionProvider,
  clearLocalSessionMentions,
  issueMentionToken,
  parseIssueMentionToken,
} from '@renderer/lib/chat/chat-mention-provider';
import { createLocalSessionMentionProvider } from '@renderer/lib/chat/local-session-mention-provider';
import { useSessionAgentCreationTools } from '@renderer/lib/chat/use-session-agent-creation-tools';
import { useSessionMentionDrop } from '@renderer/lib/chat/use-session-mention-drop';
import { pathMention } from '@renderer/lib/drag-files';
import { getDraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { linkedIssueMentionName, type LinkedIssue } from '@shared/core/linked-issue';
import type { AcpChatStore } from './acp-chat-store';
import { filterSlashCommands } from './slash-command-matching';

type Translate = ReturnType<typeof useSessionMessages>['translate'];
type PromptLibrary = ReturnType<typeof usePromptLibrary>;

/** `/mcp` 这条自有命令的匹配 —— 与 agent 命令同一口径:空查询全列,否则按名字包含。 */
function commandMatchesClientQuery(normalized: string): boolean {
  return normalized.length === 0 || 'mcp'.includes(normalized);
}
const ISSUE_SEARCH_MIN_LENGTH = 2;
const ISSUE_SEARCH_LIMIT = 20;

function toIssueMentionItem(issue: LinkedIssue): MentionItem {
  const token = issueMentionToken(issue.provider, issue.identifier);
  return {
    id: token,
    label: token,
    name: linkedIssueMentionName(issue),
    kind: 'issue',
    description: issue.title,
    icon: <IntegrationIcon provider={issue.provider} size={13} />,
  };
}

function issueMatchesQuery(issue: LinkedIssue, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [issue.identifier, issue.displayIdentifier, issue.title]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(normalized));
}

/**
 * What the session composer offers after `@` and accepts as a drop: sessions on this computer, workspace files,
 * issues of the project's connected provider, and session rows dragged from the sidebar.
 */
export function useComposerMentions({ store, editorApiRef, composerSlot, attachFiles, translate }: {
  store: AcpChatStore;
  editorApiRef: RefObject<PromptEditorRef | null>;
  composerSlot: HTMLElement;
  attachFiles: (files: File[]) => Promise<void>;
  translate: Translate;
}) {
  const workspaceId = useObserver(
    () => asProvisioned(getSessionPageStore(store.projectId, store.sessionId))?.workspaceId
  );
  const linkedIssue = useObserver(
    () => getRegisteredSessionData(store.projectId, store.sessionId)?.linkedIssue
  );
  const issueProviderContext = useObserver(() => {
    const mounted = asMounted(getProjectStore(store.projectId));
    return {
      projectPath: mounted?.data.path,
      repositoryUrl:
        mounted?.gitRepository.issueRepositoryUrl ??
        mounted?.gitRepository.canonicalRepositoryUrl ??
        undefined,
      selectedIssueProvider: getProjectViewStore(store.projectId)?.selectedIssueProvider ?? null,
    };
  });
  const { connectedProviders, isProviderUsable } = useConnectedIssueProviders(issueProviderContext);
  const { byEngine: agentCreationToolsByEngine, renderMentionIcon: renderAgentMentionIcon } = useSessionAgentCreationTools();
  const issueProvider = useMemo(() => {
    const selected = issueProviderContext.selectedIssueProvider;
    if (selected && isProviderUsable(selected)) return selected;
    return connectedProviders[0] ?? null;
  }, [connectedProviders, isProviderUsable, issueProviderContext.selectedIssueProvider]);

  const localSessionMentionProvider = useMemo(
    () =>
      createLocalSessionMentionProvider({
        excludeSessionId: store.sessionId,
        mentionUri: store.chatState.uri ?? store.sessionId,
        creationToolsByEngine: agentCreationToolsByEngine,
      }),
    [agentCreationToolsByEngine, store],
  );

  // Transcript parsing is synchronous, so seed the task-scoped mention registry as soon as
  // the panel mounts instead of waiting for the user to open the @ popup.
  useEffect(() => {
    if (!window.electronAPI) return;
    let active = true;
    const mentionUri = store.chatState.uri ?? store.sessionId;
    // Registering is a side effect of the search, so a search that settles AFTER this effect was
    // cleaned up writes an entry nobody clears again. Clear it here instead of skipping the
    // register: by then the only thing that knows the entry is stale is this closure.
    // The provider itself logs and returns [] on failure, so there is no rejection to catch —
    // a second catch here would be dead code that reads like the error handler.
    void localSessionMentionProvider.search('').then(() => {
      if (!active) clearLocalSessionMentions(mentionUri);
    });
    return () => {
      active = false;
      clearLocalSessionMentions(mentionUri);
    };
  }, [localSessionMentionProvider, store]);

  // 侧栏会话行拖进来 = 与 @ 弹层同一枚 pill(behavior session-page「把会话拖成 @」)。
  const { dataDropTypes, onDataDropped } = useSessionMentionDrop({
    provider: localSessionMentionProvider,
    editorApiRef,
    selfSessionId: store.sessionId,
    attachFiles: (files) => {
      attachFiles(files).catch((error: unknown) => log.error('Failed to attach dropped files', { error }));
    },
    // A folder on this computer: the same pill a folder dropped from the system gets; a task on another machine cannot read it.
    dropFolder: (path) => {
      if (machineRegistry.machineOf(store.projectId)) toast({ title: translate('chat.folderDropUnsupportedTitle'), variant: 'destructive' });
      else editorApiRef.current?.insertMention(pathMention(path));
    },
  });

  // 落在这条会话的**正中**(聊天记录那一片)也算落在输入框上(behavior session-page「把会话拖成 @」):一块的上下左右边
  // 先被这一屏收走分出一块(screen-frame 的捕获阶段),剩下的才走到这里。composer 自己那一格由它自己收,这里只兜它
  // 够不到的地方,❌ 两边都收(会插两枚)。owner 2026-10-15「拖到边缘是分屏,中间是 session 信息粘贴」——
  // 取代 10-09 那句「正中什么都不发生」(那次把这一段删了,于是拖进来要么分屏、要么没反应)。
  useEffect(() => {
    const surface = composerSlot.closest('[data-session-chat-surface]');
    if (!(surface instanceof HTMLElement)) return;
    const accepts = (event: DragEvent) => event.dataTransfer && getDraggedScreenContent(event.dataTransfer)?.kind === 'session';
    const onDragOver = (event: DragEvent) => {
      if (accepts(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!accepts(event)) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-slot="composer-bar"]')) return;
      event.preventDefault();
      onDataDropped(event.dataTransfer!);
    };
    surface.addEventListener('dragover', onDragOver);
    surface.addEventListener('drop', onDrop);
    return () => {
      surface.removeEventListener('dragover', onDragOver);
      surface.removeEventListener('drop', onDrop);
    };
  }, [composerSlot, onDataDropped]);

  const mentionProvider = useMemo<ContextMentionProvider | undefined>(() => {
    const wsId = workspaceId;
    const resultsChanged = new Set<() => void>();
    return {
      resolve(target, label) {
        const meta = chatMentionProvider.resolve(target, store.chatState.uri ?? store.sessionId);
        return meta ? { id: meta.id, label: target, name: label, kind: meta.kind,
          role: target.startsWith('aid:') ? 'agent' : undefined, engine: meta.engine,
          description: meta.title } : null;
      },
      onResultsChanged(listener: () => void) {
        resultsChanged.add(listener);
        return () => resultsChanged.delete(listener);
      },
      async search(query: string, options?: { requery?: boolean }): Promise<MentionItem[]> {
        // 「@」刚打出来(查询还是空的):让文件索引补一遍 —— 只有一个目录一个 watch 的平台上它才真的去扫
        // (没人盯着的目录里新建的文件靠这一下进索引)。❌ 等它:先用现有索引出结果,扫完再让弹层按当前查询重查一次。
        // 重查(重扫完了编辑器按同一查询再问一次)❌ 再触发:否则停在「@」上会一轮接一轮全量重扫。
        if (query === '' && wsId && !options?.requery) {
          void nudgeWorkspace(store.projectId, wsId, { reindex: true }).then((rescanned) => {
            if (rescanned) for (const listener of [...resultsChanged]) listener();
          });
        }
        const pinnedIssue =
          linkedIssue && issueMatchesQuery(linkedIssue, query)
            ? toIssueMentionItem(linkedIssue)
            : null;
        const issueSearch =
          issueProvider && query.trim().length >= ISSUE_SEARCH_MIN_LENGTH
            ? rpc.issues
                .searchIssues(issueProvider, {
                  limit: ISSUE_SEARCH_LIMIT,
                  searchTerm: query.trim(),
                  projectId: store.projectId,
                  projectPath: issueProviderContext.projectPath,
                  repositoryUrl: issueProviderContext.repositoryUrl ?? undefined,
                })
                .catch((error: unknown) => {
                  log.warn('Failed to search issue mentions', { provider: issueProvider, error });
                  return null;
                })
            : Promise.resolve(null);

        const [files, issueResult, localSessionItems] = await Promise.all([
          wsId
            ? rpc.search.searchWorkspaceFiles({ workspaceId: wsId, query })
            : Promise.resolve([]),
          issueSearch,
          localSessionMentionProvider.search(query),
        ]);

        const pinnedIssueItems: MentionItem[] = [];
        const searchedIssueItems: MentionItem[] = [];
        const seenIssueIds = new Set<string>();
        if (pinnedIssue) {
          pinnedIssueItems.push(pinnedIssue);
          seenIssueIds.add(pinnedIssue.id);
        }
        if (issueResult?.success) {
          for (const issue of issueResult.data) {
            const item = toIssueMentionItem(issue);
            if (seenIssueIds.has(item.id)) continue;
            seenIssueIds.add(item.id);
            searchedIssueItems.push(item);
          }
        } else if (issueResult && !issueResult.success) {
          log.warn('Failed to search issue mentions', {
            provider: issueProvider,
            error: issueResult.error,
          });
        }

        const fileItems = files.map((f) => ({
          id: f.path,
          label: f.path,
          name: f.filename,
          kind: 'file' as const,
          description: f.path,
        }));

        return [...localSessionItems, ...pinnedIssueItems, ...fileItems, ...searchedIssueItems];
      },
    };
  }, [
    workspaceId,
    linkedIssue,
    issueProvider,
    store.projectId,
    issueProviderContext.projectPath,
    issueProviderContext.repositoryUrl,
    agentCreationToolsByEngine,
    localSessionMentionProvider,
  ]);

  const renderMentionIcon = useCallback(
    (attrs: Parameters<typeof renderAgentMentionIcon>[0]) => {
      const { id, kind } = attrs;
      if (kind === 'custom') return renderAgentMentionIcon(attrs);
      if (kind !== 'issue') return null;
      const target = parseIssueMentionToken(id);
      if (!target) return null;
      return <IntegrationIcon provider={target.provider} size={12} />;
    },
    [renderAgentMentionIcon]
  );

  return { mentionProvider, dataDropTypes, onDataDropped, renderMentionIcon };
}

/** What the session composer offers after `/`: the agent's commands, the person's and Apps' prompts, and `/mcp`. */
export function useComposerSlashItems({ store, promptLibrary, promptOverrides, translate, providerId }: {
  store: AcpChatStore;
  promptLibrary: PromptLibrary['value'];
  promptOverrides: PromptLibrary['overrides'];
  translate: Translate;
  providerId: string | null;
}) {
  const querySlashItems = useCallback(
    async (query: string): Promise<CommandItem[]> => {
      const normalized = query.trim().toLowerCase();
      const commands = filterSlashCommands(store.commands, normalized)
        .map((command) => ({
          ...command,
          // Codex's `/compact` is implemented by gugu's own bridge (codex-app-server-acp.mjs), so its line follows the UI
          // language like `/mcp`; commands the agent itself reports keep the agent's own wording.
          ...(providerId === 'codex' && command.name === 'compact' ? { description: translate('chat.commandCompactDescription') } : {}),
          section: translate('chat.commands'),
        }));
      // 提示词:我的一组,各 App 各一组(prompt-slash-items.ts,聊天输入框用的是同一份)。
      const prompts = promptSlashItems(promptLibrary, promptOverrides, translate('chat.prompts'), normalized);
      // @@@gugu-client-commands —— `/mcp` 是**咕咕自己的**命令,不是 agent 报上来的:
      // 选中时被 `onCommand` 拦下来开面板,**一个字都不发给 agent**。
      // ⚠️ 它出现在这里的前提是 apply 那条路已经接通(面板 → 记录 → 重开)——
      //    一条点了没反应的命令就是假控件,那是这仓零容忍的。
      const clientCommands: CommandItem[] = commandMatchesClientQuery(normalized)
        ? [
            {
              id: GUGU_CLIENT_COMMAND_MCP,
              name: 'mcp',
              token: '/mcp',
              label: '/mcp',
              description: translate('mcpSession.commandDescription'),
              behavior: 'execute' as const,
              section: translate('chat.commands'),
            },
          ]
        : [];
      return [...clientCommands, ...commands, ...prompts];
    },
    [store, promptLibrary, promptOverrides, translate, providerId]
  );

  return querySlashItems;
}
