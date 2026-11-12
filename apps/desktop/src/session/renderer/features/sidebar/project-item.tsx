import { observer } from 'mobx-react-lite';
import { useCallback, useEffect } from 'react';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import { getProjectStore, getGitRepositoryStore } from '@renderer/features/projects/stores/project-selectors';
import { useNavigate, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { isScreenView, showBesideOnScreen, showOnScreen } from '@renderer/app/screen-layout-actions';
import { screenLayout } from '@renderer/app/screen-layout';
import { readComposerVerb, setComposerVerb } from '@/lib/composerVerbBridge';
import { composerDrafts, projectDraftKey } from '@renderer/features/sessions/composer-drafts';
import { ProjectRowContextMenu } from '@/components/chat/ProjectRowContextMenu';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { sessionKeyboardNav } from './session-keyboard-nav';
import { OneListProjectRow } from './project-row-parts';
import { requestTopicSplit } from '@/lib/topicSplitRequest';
import { useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { openChatOnScreen } from '@renderer/features/chats/open-chat';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * #2548 a project in the one list is its project group's conversation row. `projectId` is a row of the account project
 * list (sidebarStore.sidebarProjects) whose group is not a conversation of the chat list yet, so it is drawn as that row
 * would be (OneListProjectRow: the project cover, name, no preview); same click, same menu. The cover is keyed by the
 * row's representative local project, as partnerProjects keys every project group's cover. #6264 a project on another
 * machine is this row too; that machine not connected = the row reads offline (data-offline), the project stays listed.
 */
export const SidebarProjectItem = observer(function SidebarProjectItem({ projectId }: { projectId: string }) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const confirmDeleteProject = useConfirmDeleteProject();
  const { translate } = useSessionMessages();

  const project = getProjectStore(projectId);
  const ref = sidebarStore.sidebarProjects.find((row) => row.id === projectId);

  const prefetchRepository = useCallback(() => {
    const repo = getGitRepositoryStore(projectId);
    void repo?.localData.load();
    void repo?.remoteData.load();
  }, [projectId]);

  // This row is the one being looked at when the screen's focused block is this project's block. Navigation follows the
  // screen (followFocus) and can lag it; judging from navigation let a click on this row do nothing while a session
  // block filled the screen.
  const rowId = sidebarStore.rowProjectIdOf(projectId);
  const focusedBlock = screenLayout.focusedBlockId ? screenLayout.blocks.get(screenLayout.focusedBlockId) : undefined;
  const isProjectActive = isScreenView(currentView) && focusedBlock?.kind === 'project' && focusedBlock.projectId === rowId;

  useEffect(() => {
    if (isProjectActive) prefetchRepository();
  }, [isProjectActive, prefetchRepository]);

  // gugu-dev#181 项目就是群(账号上的项目 = 它的项目群):项目群从哪个话题叫到了你,壳发过来的那一份。
  const groupChatId = ref?.chatId;
  const chatSignals = useSidebarChatSignals();
  const callingTopic = chatSignals?.groupCallingTopic.get(groupChatId ?? '');

  if (ref?.kind === 'group') return <OneListGroupProjectRow projectId={projectId} chatId={ref.chatId} name={ref.name} />;
  if (!project) return null;
  const deviceIds = [...new Set(sidebarStore.projectMembersOf(projectId).map((id) => machineRegistry.machineOf(id) ?? null))];
  const machineDown = deviceIds.every((id) => id !== null && remoteHostsStore.connectionState(id) !== 'connected');
  const projectName = ref?.name || project.name;
  const projectLabel = projectName ?? 'project';
  const openProject = (beside = false) => {
    // 行尾的数里有话题叫到你:话题不是项目行的子行,这一下就是去读它的入口(owner 11-07「红点消不掉」)。
    if (callingTopic && groupChatId) requestTopicSplit({ chatId: callingTopic.chatId, name: callingTopic.name, sourceChatId: groupChatId, focusComposer: true });
    // behavior session-page「键盘导航」: the project row is a station too, so a click moves the cursor
    // onto it — ↓ afterwards continues from here.
    sessionKeyboardNav.syncCursorFromPointer({ kind: 'project', projectId });
    // ⌘ 点 = 项目块拼到正看着那块右边(gugu-dev#181:项目是一块,和会话行同一个手势)。
    if (beside && isScreenView(appState.navigation.currentViewId)) {
      showBesideOnScreen({ kind: 'project', projectId: rowId });
      return;
    }
    if (isProjectActive) {
      // gugu-dev#181 正在开新任务时点这一行 = 回到群聊:还没打字,「新任务」一起撤掉;打了字就留着。
      if (groupChatId && readComposerVerb(groupChatId) === 'task' && !composerDrafts.get(projectDraftKey(projectId)).trim()) setComposerVerb(groupChatId, null);
      return;
    }
    // The project's block (its group) goes on screen; navigation follows it.
    showOnScreen({ kind: 'project', projectId: rowId });
  };

  const removeProject = () => {
    void confirmDeleteProject({
      projectId,
      projectLabel: project.name ?? translate('projects.fallbackName'),
      onDeleted: () => { if (isProjectActive) navigate('home'); },
    });
  };

  return (
    <ProjectRowContextMenu disabled={false} chatId={groupChatId} onRemove={removeProject}>
      <OneListProjectRow
        name={projectLabel}
        coverId={rowId}
        preview=""
        selected={isProjectActive}
        onOpen={openProject}
        aria-label={translate('sidebar.openProject', { project: projectLabel })}
        data-project-row={projectId}
        data-offline={machineDown || undefined}
      />
    </ProjectRowContextMenu>
  );
});

/**
 * An account project with no local project in this table (no folder on any machine, or its folders are only on machines
 * not loaded yet): its row is still there and opens its project group (openChatOnScreen, as a group row of the list does).
 * The cover is keyed by the group, as partnerProjects keys a project with no folder.
 */
const OneListGroupProjectRow = observer(function OneListGroupProjectRow({ projectId, chatId, name }: { projectId: string; chatId: string; name: string }) {
  const { translate } = useSessionMessages();
  const focused = screenLayout.focusedBlockId ? screenLayout.blocks.get(screenLayout.focusedBlockId) : undefined;
  const open = (beside: boolean) => {
    sessionKeyboardNav.syncCursorFromPointer({ kind: 'project', projectId });
    openChatOnScreen(chatId, beside);
  };
  return (
    <OneListProjectRow
      name={name}
      coverId={chatId}
      preview=""
      selected={focused?.kind === 'chat' && focused.chatId === chatId}
      onOpen={open}
      aria-label={translate('sidebar.openProject', { project: name })}
      data-project-row={projectId}
      data-project-chat={chatId}
    />
  );
});
