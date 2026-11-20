import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactElement } from 'react';
import { readComposerVerbChat, setComposerVerb, takeComposerCarry, useComposerVerb } from '@/lib/composerVerbBridge';
import { platform } from '@/platform';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { useNewSessionMachine } from '@renderer/features/remote-hosts/use-new-session-machine';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sessionpageMessageHost } from '@renderer/lib/sessionpage-message-host';
import { log } from '@renderer/utils/logger';
import { ComposerBirthGroupChip, ComposerProjectPicker } from './composer-context-tray';
import { ComposerFolderPicker } from '@renderer/features/projects/components/main-panel/composer-folder-picker';
import { useGroupFolderStage } from '@renderer/features/folders/group-folder-stage';
import { groupFoldersStore } from '@renderer/features/folders/group-folders-store';
import { composerDrafts } from './composer-drafts';
import { ComposerTray } from './composer-tray';
import { ensureImplicitSessionHomeProjectId } from './implicit-session-home-project';
import { NewSessionComposer } from './new-session-page';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName } from './session-composer-styles';
import { cancelComposerVerb, composerVerbLook } from './composer-verb-tag';
import { machineComposerProps } from './use-machine-create-target';

export function taskDispatchDraftKey(chatId: string): string {
  return `task:${chatId}`;
}

/**
 * gugu-dev#181「派任务」:对话块的输入框选了「新任务」(composerVerbBridge)时,换上来的就是这个框 —— 与新建会话页
 * 同一个托盘 + NewSessionComposer,❌ 另一条建会话的路。发出去的那句话由宿主落成这个对话里的一张任务卡
 * (taskChatId),结果回这里;建完人留在原处、框还原成发消息。
 * 托盘是 群 · 机器 · (文件夹)· 群名。选了群:机器和文件夹与群页同一套(useGroupFolderStage),任务就住那个群;没选 = 选哪台
 * 机器的任务工作区。选的群按这个对话记(没选过 = 最近一次选的);话题里派的(`inGroup`)例外:群一格每次都空着,只认这一次
 * 明确选的 —— 沿用上回的选择会让它悄悄住进一个这次没选的群。`joinChat` = 这个 agent 进群(群里派的;私聊里 agent 进不去,
 * 卡留在私聊、结果回它自己的会话)。群主线里的新任务是群首页那个框(GroupTaskComposer)。
 */
export const TaskDispatchComposer = observer(function TaskDispatchComposer({
  chatId,
  chatName,
  joinChat = false,
  inGroup = joinChat,
  verbKey = chatId,
  onSessionCreated,
}: {
  chatId: string;
  /** 群名(托盘上那一格);`joinChat` 时要。 */
  chatName?: string;
  joinChat?: boolean;
  /** #2599 这是一个群或它的一个话题(话题里派的 agent 不进群,但同样住在这个群):项目一格每次都空着。缺省 = `joinChat`。 */
  inGroup?: boolean;
  /** 这个词记在 composerVerbBridge 的哪一格;缺省 = 这个对话(没有项目的会话里选的记在那条会话上,卡落它的私聊)。 */
  verbKey?: string;
  /** 建好之后(框已还原):会话里派的,新会话拼到右边。 */
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
}) {
  const { translate } = useSessionMessages();
  // #2548 the chip reads 「新智能体」, as the composer button that opened this box (mock v33 派智能体); the box asks
  // 「想让新智能体做点什么？」 (already says it is a new one, so no per-caller wording) and the group chip reads 「进群：群名」.
  const draftKey = taskDispatchDraftKey(verbKey);
  // 选词那一刻框里写着的话跟过来:要在 NewSessionComposer 挂上(读草稿)之前放好。
  useState(() => {
    const carried = takeComposerCarry(verbKey);
    if (carried) composerDrafts.set(draftKey, carried);
    return null;
  });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const localDeviceId = useLocalDeviceId();
  const remembered = useChatGroupMemory(chatId, inGroup ? null : localDeviceId);
  useEffect(() => {
    if (remembered && selectedId === undefined) setSelectedId(remembered);
  }, [remembered, selectedId]);
  const implicitProjectId = useImplicitProjectId(!selectedId);

  const pickProject = (groupChatId: string | undefined) => {
    setSelectedId(groupChatId);
    if (localDeviceId && !inGroup) {
      // @@@group-folders the chat remembers the group picked (the stored field still reads `projectId`; it holds the group's chat id).
      void sessionpageMessageHost().rememberTaskProject(chatId, localDeviceId, groupChatId ?? null).catch((error: unknown) => {
        log.warn('remember the project picked for a chat failed', { chatId, error: error instanceof Error ? error.message : String(error) });
      });
    }
  };
  const projectPicker = <ComposerProjectPicker selectedId={selectedId} onSelect={pickProject} />;
  const tray = {
    draftKey,
    chatId,
    birthChip: joinChat && chatName ? <ComposerBirthGroupChip name={chatName} /> : null,
    composer: {
      placeholder: translate('taskDispatch.placeholderAgent'),
      verb: composerVerbLook('task', { label: translate('taskDispatch.agent'), onCancel: () => cancelComposerVerb(verbKey, draftKey), testId: 'task-dispatch' }),
      taskChatId: chatId,
      openAfterCreate: false,
      // A task dispatched in a group lives in it (its agent joins); a group picked in the tray overrides it (GroupDispatch).
      groupChatId: joinChat ? chatId : undefined,
      onSessionCreated: (result: { projectId: string; sessionId: string }) => {
        setComposerVerb(verbKey, null);
        onSessionCreated?.(result);
      },
    },
  };
  return (
    <div data-testid="task-dispatch-composer" data-chat-id={chatId}>
      {selectedId ? (
        <GroupDispatch key={selectedId} groupChatId={selectedId} projectPicker={projectPicker} {...tray} />
      ) : (
        <MachineDispatch projectPicker={projectPicker} implicitProjectId={implicitProjectId} {...tray} />
      )}
    </div>
  );
});

type DispatchTray = {
  draftKey: string;
  chatId: string;
  projectPicker: ReactElement;
  birthChip: ReactElement | null;
  composer: Omit<Parameters<typeof NewSessionComposer>[0], 'draftKey' | 'projectId'>;
};

/** 选了群:在哪台跑、用哪个文件夹,与群页的新任务框同一套(群的文件夹在哪些机器上,没有的机器点了先挂文件夹)。 */
const GroupDispatch = observer(function GroupDispatch({ groupChatId, draftKey, projectPicker, birthChip, composer }: DispatchTray & { groupChatId: string }) {
  const stage = useGroupFolderStage(groupChatId);
  const { scopedFolders, targetFolderId, executionDevice, machineContext, machineOf, pickAndAttach } = stage;
  return (
    <ComposerTray
      projectPicker={projectPicker}
      devicePicker={stage.runMachinePicker}
      folderPicker={
        <>
          <ComposerFolderPicker
            folders={scopedFolders}
            machineLabelOf={(deviceId) => machineOf(deviceId).label}
            onAttach={() => void pickAndAttach(executionDevice)}
          />
          {birthChip}
        </>
      }
      host={machineContext?.host ?? machineLibraryHost(null)}
    >
      <NewSessionComposer
        key={targetFolderId ?? 'none'}
        draftKey={draftKey}
        {...composer}
        groupChatId={groupChatId}
        onSessionCreated={(result) => {
          stage.runMachine.created();
          composer.onSessionCreated?.(result);
        }}
        workspaceId={targetFolderId}
        {...machineComposerProps(machineContext, { projectId: targetFolderId ?? undefined, isContextPending: scopedFolders.folders === null })}
      />
    </ComposerTray>
  );
});

/** 没选群:选哪台机器,就在那台的任务工作区里跑。 */
const MachineDispatch = observer(function MachineDispatch({ draftKey, projectPicker, birthChip, composer, implicitProjectId }: DispatchTray & { implicitProjectId: string | undefined }) {
  const { remote, machineContext, devicePicker } = useNewSessionMachine();
  return (
    <ComposerTray projectPicker={projectPicker} devicePicker={devicePicker} folderPicker={birthChip} host={machineContext?.host ?? machineLibraryHost(null)}>
      <NewSessionComposer
        key={remote?.deviceId ?? 'local'}
        draftKey={draftKey}
        {...composer}
        {...machineComposerProps(machineContext, { projectId: implicitProjectId })}
      />
    </ComposerTray>
  );
});

/**
 * 对话底下那一格:输入框选了「新任务」就摆新任务的框,没选 = 什么都不摆(对话自己的框在)。
 * 对话块放这一个(项目块的新任务是项目首页那个框),与 InputArea 收起自己是同一个读数(useComposerVerb)。
 */
export function ComposerVerbDock({ chatId }: { chatId: string }) {
  const verb = useComposerVerb(chatId);
  if (!verb) return null;
  // 群名、派出去的 agent 进不进得了这个对话,由选词的那个输入框记下(composerVerbBridge)。
  const chat = readComposerVerbChat(chatId);
  return (
    <div className={sessionComposerDockBandClassName}>
      <div className={sessionComposerDockedWidthClassName}>
        <TaskDispatchComposer chatId={chatId} chatName={chat?.name} joinChat={chat?.joinable} inGroup={chat?.inGroup} />
      </div>
    </div>
  );
}

function useLocalDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(platform.getLocalDeviceSelfSnapshot?.()).then(
      (self) => { if (live) setId(self?.device_id ?? null); },
      () => undefined,
    );
    return () => { live = false; };
  }, []);
  return id;
}

/** The group this chat remembers (a group with folders now; archived / unbound = none); none remembered = the last one picked here. */
function useChatGroupMemory(chatId: string, deviceId: string | null): string | undefined {
  const [remembered, setRemembered] = useState<{ chatId: string; groupChatId: string } | null>(null);
  useEffect(() => {
    if (!deviceId) return;
    let live = true;
    void sessionpageMessageHost().rememberedTaskProject(chatId, deviceId).then(
      (choice) => { if (live && choice) setRemembered({ chatId, groupChatId: choice.projectId }); },
      (error: unknown) => log.warn('read the group remembered for a chat failed', { chatId, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => { live = false; };
  }, [chatId, deviceId]);
  // Read in the observer's render: when the group folders change, read again (❌ only once when the memory came back).
  const groupChatId = remembered?.chatId === chatId ? remembered.groupChatId : undefined;
  return groupChatId && groupFoldersStore.foldersOf(groupChatId).length > 0 ? groupChatId : undefined;
}

/** 没选群,或群一个文件夹都没挂(Q5):与新建会话页同一个隐式工作目录(task home)。`wanted` = 这一刻要它。 */
export function useImplicitProjectId(wanted: boolean): string | undefined {
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!wanted || projectId) return;
    let live = true;
    void ensureImplicitSessionHomeProjectId().then(
      (id) => { if (live && id) setProjectId(id); },
      (error: unknown) => log.warn('prepare the implicit project for a task failed', { error: error instanceof Error ? error.message : String(error) }),
    );
    return () => { live = false; };
  }, [wanted, projectId]);
  return projectId;
}
