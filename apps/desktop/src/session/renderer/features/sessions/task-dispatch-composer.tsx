import { observer } from 'mobx-react-lite';
import { useState, type ReactElement } from 'react';
import { Unknown } from '@/components/ui/Unknown';
import { ReadFailedLine } from '@renderer/lib/ui/read-failed-line';
import { replica, useReplica } from '@/lib/replica';
import { devicesModel } from '@/store/devicesCache';
import { readComposerVerbChat, setComposerVerb, takeComposerCarry, useComposerVerb } from '@/lib/composerVerbBridge';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { useNewSessionMachine } from '@renderer/features/remote-hosts/use-new-session-machine';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sessionpageMessageHost } from '@renderer/lib/sessionpage-message-host';
import { log } from '@renderer/utils/logger';
import { ComposerBirthGroupChip, ComposerProjectPicker } from './composer-context-tray';
import { ComposerFolderPicker } from '@renderer/features/projects/components/main-panel/composer-folder-picker';
import { useProjectFolderStage } from '@renderer/features/projects/components/main-panel/project-folder-stage';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { rememberedTaskRow, taskProjectChoice } from './task-project-memory';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { composerDrafts } from './composer-drafts';
import { ComposerTray } from './composer-tray';
import { implicitSessionHome } from './implicit-session-home-project';
import { NewSessionComposer } from './new-session-page';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName } from './session-composer-styles';
import { cancelComposerVerb, composerVerbLook } from './composer-verb-tag';
import { machineComposerProps } from './use-machine-create-target';

/**
 * The project a chat remembers for new tasks on this computer (the host keeps it per chat and device). Read when the
 * dispatch box opens, ❌ pushed; a pick writes it (`set` once the host stored it). Not kept across restarts.
 */
export const chatTaskProject = replica({
  name: 'chatTaskProject',
  scope: 'account',
  read: (_owner, chatId: string, deviceId: string) => sessionpageMessageHost().rememberedTaskProject(chatId, deviceId).catch((error: unknown) => {
    log.warn('read the project remembered for a chat failed', { chatId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }),
  fresh: 0,
});

export function taskDispatchDraftKey(chatId: string): string {
  return `task:${chatId}`;
}

/**
 * gugu-dev#181「派任务」:对话块的输入框选了「新任务」(composerVerbBridge)时,换上来的就是这个框 —— 与新建会话页
 * 同一个托盘 + NewSessionComposer,❌ 另一条建会话的路。发出去的那句话由宿主落成这个对话里的一张任务卡
 * (taskChatId),结果回这里;建完人留在原处、框还原成发消息。
 * 托盘是 项目 · 机器 · (文件夹)· 群名。选了项目:机器和文件夹与项目块同一套(useProjectFolderStage);没选 = 选哪台机器的任务工作区。
 * 项目按这个对话记(没选过 = 最近一次选的);群和它的话题里派的(`inGroup`)例外:项目一格每次都空着,只认这一次明确选的 ——
 * 选了项目它就住那个项目,没选就住这个群(#2599),沿用上回的选择会让它悄悄住进一个这次没选的项目。`joinChat` = 这个 agent 进群
 * (群里派的;私聊里 agent 进不去,卡留在私聊、结果回它自己的会话)。项目块里的新任务是项目首页那个框(ProjectTaskComposer)。
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
  // What the person picked here (null = nothing picked yet: the chat's remembered project shows).
  const [picked, setPicked] = useState<{ projectId: string | undefined } | null>(null);
  const devices = useReplica(devicesModel, []);
  const localDeviceId = devices.state === 'value' ? devices.value.find((device) => device.is_current_device)?.device_id ?? null : null;
  // 这个对话记着的项目(哪台机器上的都算,认回账号上的项目):群和它的话题里 ❌ 沿用(#2599)。
  const remembers = !inGroup && picked === null;
  const memory = useReplica(chatTaskProject, remembers && localDeviceId ? [chatId, localDeviceId] : null);
  // The project shown: the one picked; else (outside a group) the remembered one, unknown until it is read — ❌ "no
  // project" first and the remembered one popping in. 在 observer 的渲染里认:账号上的项目列表变了,跟着重认。
  // A memory that could not be read is said where the project picker goes, with a retry, and nothing is sent until it is
  // known: ❌ "no project" drawn and the task sent to the implicit directory instead of the project used last (review 4
  // Q3). A device with no row of its own has no memory to read (nothing was ever remembered for it here).
  const selection: { known: true; projectId: string | undefined } | { known: false; failed: Error | null } = picked
    ? { known: true, projectId: picked.projectId }
    : !remembers ? { known: true, projectId: undefined }
    : devices.state === 'error' ? { known: false, failed: devices.error }
    : memory.state === 'error' ? { known: false, failed: memory.error }
    : devices.state === 'unknown' || (localDeviceId !== null && memory.state === 'unknown') ? { known: false, failed: null }
    : { known: true, projectId: memory.state === 'value' && memory.value ? rememberedTaskRow(memory.value, accountProjectsStore) : undefined };
  const retryMemory = () => {
    if (devices.state === 'error') void devicesModel.refresh();
    else if (localDeviceId) void chatTaskProject.refresh(chatId, localDeviceId);
  };
  const selectedId = selection.known ? selection.projectId : undefined;
  // 没选项目:与新建会话页同一个隐式工作目录(「未选择项目」是真状态,不是列表第一个)。
  const implicitProject = useReplica(implicitSessionHome, selection.known && !selectedId ? [] : null);
  const implicitProjectId = implicitProject.state === 'value' ? implicitProject.value : undefined;

  const pickProject = (projectId: string | undefined) => {
    setPicked({ projectId });
    if (localDeviceId && !inGroup) {
      const choice = taskProjectChoice(projectId, localDeviceId, (id) => machineRegistry.machineOf(id));
      const entry = chatTaskProject.at(chatId, localDeviceId);
      void sessionpageMessageHost().rememberTaskProject(chatId, choice.deviceId, choice.projectId).then(() => {
        entry.set(choice.projectId ? { deviceId: choice.deviceId, projectId: choice.projectId } : null);
      }, (error: unknown) => {
        log.warn('remember the project picked for a chat failed', { chatId, error: error instanceof Error ? error.message : String(error) });
      });
    }
  };
  const projectPicker = selection.known
    ? <ComposerProjectPicker selectedId={selectedId} onSelect={pickProject} />
    : <Unknown className="h-6 w-24" />;
  const tray = {
    draftKey,
    chatId,
    birthChip: joinChat && chatName ? <ComposerBirthGroupChip name={chatName} /> : null,
    composer: {
      placeholder: translate('taskDispatch.placeholderAgent'),
      verb: composerVerbLook('task', { label: translate('taskDispatch.agent'), onCancel: () => cancelComposerVerb(verbKey, draftKey), testId: 'task-dispatch' }),
      taskChatId: chatId,
      openAfterCreate: false,
      birthChatId: joinChat ? chatId : undefined,
      onSessionCreated: (result: { projectId: string; sessionId: string }) => {
        setComposerVerb(verbKey, null);
        onSessionCreated?.(result);
      },
    },
  };
  return (
    <div data-testid="task-dispatch-composer" data-chat-id={chatId}>
      {/* The remembered project not read yet: the box's place is held (❌ the machine box first, then the project's). */}
      {!selection.known ? (
        selection.failed ? (
          // Its place, saying why, with the picker beside it: a project picked by hand is the one sent to (`picked`). No
          // composer until then, so nothing goes to the implicit directory while the project is not known.
          <div className="flex h-[132px] w-full items-start gap-3 p-3" data-testid="task-dispatch-project-failed">
            <ComposerProjectPicker selectedId={undefined} onSelect={pickProject} />
            <ReadFailedLine message={translate('taskDispatch.projectMemoryFailed')} onRetry={retryMemory} />
          </div>
        ) : <Unknown className="h-[132px] w-full" />
      ) : selectedId ? (
        <ProjectDispatch key={selectedId} projectId={selectedId} projectPicker={projectPicker} {...tray} />
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

/** 选了项目:在哪台跑、用哪个文件夹,与项目块的新任务框同一套(项目的文件夹在哪些机器上,没有的机器点了先挂文件夹)。 */
const ProjectDispatch = observer(function ProjectDispatch({ projectId, draftKey, projectPicker, birthChip, composer }: DispatchTray & { projectId: string }) {
  const stage = useProjectFolderStage(projectId);
  const { scopedFolders, targetProjectId, executionDevice, machineContext, machineOf, pickAndAttach } = stage;
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
        key={targetProjectId}
        draftKey={draftKey}
        {...composer}
        onSessionCreated={(result) => {
          stage.runMachine.created();
          composer.onSessionCreated?.(result);
        }}
        workspaceId={scopedFolders.chosen?.workspaceId ?? null}
        {...machineComposerProps(machineContext, { projectId: targetProjectId, isContextPending: scopedFolders.folders === null })}
      />
    </ComposerTray>
  );
});

/** 没选项目:选哪台机器,就在那台的任务工作区里跑。 */
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
