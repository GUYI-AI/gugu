import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { setComposerVerb, takeComposerCarry } from '@/lib/composerVerbBridge';
import { focusSessionComposer } from '@renderer/features/sidebar/session-keyboard-nav';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { ComposerProjectPicker } from '@renderer/features/sessions/composer-context-tray';
import { ComposerTray } from '@renderer/features/sessions/composer-tray';
import { NewSessionComposer } from '@renderer/features/sessions/new-session-page';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from '@renderer/features/sessions/composer-drafts';
import { machineComposerProps } from '@renderer/features/sessions/use-machine-create-target';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName } from '@renderer/features/sessions/session-composer-styles';
import { cancelComposerVerb, composerVerbLook } from '@renderer/features/sessions/composer-verb-tag';
import type { ComposerVerbLook } from '@renderer/features/sessions/session-config/initial-session-section';
import { useFloatingCardKeys } from '@renderer/app/floating-card-keys';
import { ComposerFolderPicker } from '@renderer/features/projects/components/main-panel/composer-folder-picker';
import { carryRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useGroupFolderStage, type GroupFolderStage } from './group-folder-stage';
import { useImplicitProjectId } from '@renderer/features/sessions/task-dispatch-composer';

/** A group's new-task box keeps what was written in it per group. */
export function groupDraftKey(chatId: string): string {
  return `group:${chatId}`;
}

/**
 * Go start a new task in this group: the group picker in a tray, the new-session page and the group page's own tray all
 * come through here, then open the group. What was written (`carryFrom`'s draft) goes into the group's new-task box; with
 * messages in the group the box opens as「新任务」 with the folder card floating — without, the group page is the group
 * home, whose box is a new task already. `machine` = the machine picked before (device id), picked first there.
 */
export function prepareGroupTask(chatId: string, carryFrom?: string, machine?: string): void {
  if (carryFrom) composerDrafts.moveToEmpty(carryFrom, groupDraftKey(chatId));
  if (machine) carryRunMachine(chatId, machine);
  if (readChatSummary(chatId)?.hasMessages) setComposerVerb(chatId, 'task');
}

/**
 * A group with no messages yet: its folder card above, the new-task box below (owner 2026-10-17 picked B; the greeting
 * moved into the box as its hint). The folder picked on the card = where a new task starts, the same choice as the tray's
 * folder picker. Every group has this page — a group with no folder shows the card with「0 个文件夹」and its「+」.
 */
export const GroupHome = observer(function GroupHome({ chatId }: { chatId: string }) {
  const { translate } = useSessionMessages();
  const stage = useGroupFolderStage(chatId);
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pt-24 pb-6">
        {stage.card}
      </div>
      <GroupTaskComposer
        stage={stage}
        verb={composerVerbLook('task', { label: translate('taskDispatch.task') })}
        placeholder={translate('projects.home.hero', { projectName: stage.groupName })}
      />
    </div>
  );
});

/**
 * The box a new task in a group is written in: the tray (group · device · folder) + the new-session box. The group home
 * shows it; choosing「新任务」 in a group with messages swaps the same box in (gugu-dev#181 ⑦ ⑧), ❌ a second one.
 * The first line lands as a task card in this group; the person stays in the group.
 */
export const GroupTaskComposer = observer(function GroupTaskComposer({
  stage,
  verb,
  placeholder,
  onSessionCreated,
  focusOnOpen = false,
}: {
  stage: GroupFolderStage;
  /** Put the caret in the box as it swaps in (「新任务」 picked): typing is writing the task. */
  focusOnOpen?: boolean;
  verb: ComposerVerbLook;
  placeholder: string | ((agentName: string) => string);
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { chatId, runMachinePicker, scopedFolders, executionDevice, machineContext, machineOf, pickAndAttach } = stage;
  // A group with no folder anywhere runs its new task on this computer, in the task home (v2 ⑨, Q5).
  const taskHome = useImplicitProjectId(stage.folderless);
  const targetFolderId = stage.targetFolderId ?? (stage.folderless ? taskHome ?? null : null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnOpen && boxRef.current) focusSessionComposer(boxRef.current);
  }, [focusOnOpen]);
  // Another group picked in the tray = start the task there; what was written follows (when that box is empty).
  const openGroup = (nextId: string | undefined) => {
    if (nextId === chatId) return;
    if (!nextId) {
      composerDrafts.moveToEmpty(groupDraftKey(chatId), NEW_SESSION_DRAFT_KEY);
      navigate('new-session');
      return;
    }
    prepareGroupTask(nextId, groupDraftKey(chatId));
    navigate('chat', { chatId: nextId });
  };
  return (
    <div className={sessionComposerDockBandClassName}>
      <div ref={boxRef} className={sessionComposerDockedWidthClassName} data-testid="project-home-composer">
        <ComposerTray
          projectPicker={<ComposerProjectPicker selectedId={chatId} onSelect={openGroup} allowNone={false} />}
          devicePicker={runMachinePicker}
          folderPicker={
            <ComposerFolderPicker
              folders={scopedFolders}
              machineLabelOf={(deviceId) => machineOf(deviceId).label}
              onAttach={() => void pickAndAttach(executionDevice)}
            />
          }
          host={machineContext?.host ?? machineLibraryHost(null)}
        >
          <NewSessionComposer
            // Another folder (or the same folder on another machine) is another place to create in: remount; the draft
            // is kept per group and follows.
            key={targetFolderId ?? 'none'}
            draftKey={groupDraftKey(chatId)}
            // gugu-dev#181: the first line lands as a task card in this group; the person stays here.
            taskChatId={chatId}
            groupChatId={chatId}
            openAfterCreate={false}
            placeholder={placeholder}
            verb={verb}
            workspaceId={targetFolderId}
            onSessionCreated={(result) => {
              stage.runMachine.created();
              onSessionCreated?.(result);
            }}
            {...machineComposerProps(machineContext, {
              projectId: targetFolderId ?? undefined,
              isContextPending: scopedFolders.folders === null,
              blockReason: scopedFolders.folders?.length === 0 && (stage.folders.folders?.length ?? 0) > 0 ? translate('projects.folders.scopeUnavailable') : null,
            })}
          />
        </ComposerTray>
      </div>
    </div>
  );
});

/**
 * A new task in a group that already has messages (gugu-dev#181「输入框」): the box turns into the new-task box (the group
 * home's, GroupTaskComposer) and the group's folder card floats above the conversation — dimmed and frosted as one
 * layer, card and box on top. Picking a paper = the task starts there and the card steps aside; Esc steps it aside too.
 * Typing does not (owner 10-26), nor clicking beside the card (owner 10-23). The card is the group home's (useGroupFolderStage).
 */
export const GroupTaskDock = observer(function GroupTaskDock({ chatId }: { chatId: string }) {
  const { translate } = useSessionMessages();
  // What the group's box held when「新任务」 was picked comes along: set before the new box mounts (reads its draft).
  useState(() => {
    const carried = takeComposerCarry(chatId);
    if (carried) composerDrafts.set(groupDraftKey(chatId), carried);
    return null;
  });
  const [cardShown, setCardShown] = useState(true);
  const stage = useGroupFolderStage(chatId, { floating: true, onChosen: () => setCardShown(false) });
  const dockRef = useRef<HTMLDivElement>(null);
  useFloatingCardKeys(cardShown, () => setCardShown(false), dockRef);
  const close = () => setComposerVerb(chatId, null);
  return (
    <>
      {cardShown ? (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-(--em-surface-base)/65 px-4 pb-32 backdrop-blur-[2px]"
          data-project-task-card=""
        >
          {stage.card}
        </div>
      ) : null}
      <div ref={dockRef} className="relative z-30">
        <GroupTaskComposer
          stage={stage}
          verb={composerVerbLook('task', { label: translate('taskDispatch.task'), onCancel: () => cancelComposerVerb(chatId, groupDraftKey(chatId)), testId: 'task-dispatch' })}
          placeholder={(agent) => translate('taskDispatch.placeholder', { agent })}
          onSessionCreated={close}
          focusOnOpen
        />
      </div>
    </>
  );
});
