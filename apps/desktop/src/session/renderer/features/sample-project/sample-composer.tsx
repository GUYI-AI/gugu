import { when } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import {
  dismissSampleProject,
  readSampleProject,
  recordSampleProjectConversion,
} from '@/lib/sampleProject';
import { messageForUser } from '@/lib/userFacingError';
import { forgetSampleProjectOnScreen } from '@renderer/app/screen-layout-actions';
import { prepareProjectTask } from '@renderer/features/projects/project-task-entry';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { isProjectPathConflictError, projectPathConflictMessage } from '@renderer/features/projects/stores/project-creation-error';
import { asMounted, getProjectManagerStore, getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { composerDrafts, projectDraftKey, type ComposerHandoff } from '@renderer/features/sessions/composer-drafts';
import { composerVerbLook } from '@renderer/features/sessions/composer-verb-tag';
import { NewSessionComposer } from '@renderer/features/sessions/new-session-page';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName } from '@renderer/features/sessions/session-composer-styles';
import { fetchAppSettingsMeta } from '@renderer/features/settings/app-settings-client';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { useAgentInstallationStatuses, useInstallingAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { sessionpageLegFor } from '@shared/core/sessions/provider-selection';
import type { SampleProjectContent } from './content/types';
import { convertSampleProject, sampleConversion, type SampleConversionDeps, type SampleConversionFailure } from './sample-conversion';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

/** 示例那一框写了一半的话暂存在这一格;变成项目那一刻整格挪进那个项目的新任务框(prepareProjectTask)。 */
export const SAMPLE_DRAFT_KEY = 'sample-project';

/** 示例变成项目之后,要等它出现在账号的项目表里多久(建群之后那次发布、项目表重读)。 */
const ROW_WAIT_MS = 20_000;

/**
 * #2569 示例底下是和项目里一样的新任务框(同一个 NewSessionComposer:智能体、模型、权限照新任务的默认)。
 * 还没有项目,所以按发送 = 先把示例变成这个人自己的项目(sample-conversion),再由那个项目的新任务框把这一句发出去。
 * 发不了要说为什么:还没有装好的智能体、正在装;变的哪一步没成、原因;❌ 只把发送键灰掉。
 */
export const SampleComposer = observer(function SampleComposer({ ownerId, content }: { ownerId: string; content: SampleProjectContent }) {
  const { translate, locale } = useSessionMessages();
  const agentNotice = useSampleAgentNotice();
  const name = translate('projects.sample.name');
  const verb = useMemo(() => composerVerbLook('task', { label: translate('taskDispatch.task') }), [translate]);
  const working = sampleConversion.status === 'working';
  const failure = sampleConversion.failure;
  const send = (input: InitialSessionState) => {
    if (!input.provider) return;
    const request = content.messages.find((message) => message.kind === 'task')?.text ?? '';
    const files = new Intl.ListFormat(locale, { type: 'conjunction' }).format(content.files.map((file) => file.name));
    const turn: Omit<ComposerHandoff, 'onCreated'> = {
      hiddenContext: translate('projects.sample.handoffContext', { name, request, files }),
      picked: {
        provider: input.provider,
        model: input.model,
        platformModel: input.platformModel,
        effort: input.effort,
        permissionMode: input.permissionMode,
        sessionView: input.sessionView,
      },
      sendWhenReady: true,
    };
    void convertSampleProject(sampleConversionHost(ownerId, turn, translate), { name, files: content.files });
  };
  return (
    <div className={sessionComposerDockBandClassName} data-sample-composer="">
      <div className={sessionComposerDockedWidthClassName}>
        <NewSessionComposer
          projectId={undefined}
          draftKey={SAMPLE_DRAFT_KEY}
          verb={verb}
          placeholder={translate('projects.home.hero', { projectName: name })}
          blocked={working || agentNotice?.kind === 'installing'}
          blockReason={agentNotice?.kind === 'none' ? agentNotice.text : null}
          sendWithoutProject={send}
        />
        {working || agentNotice?.kind === 'installing' ? (
          <p className="mt-2 px-1 text-tiny text-foreground-passive" data-sample-composer-status="">
            {working ? translate('projects.sample.convert.working') : agentNotice?.text}
          </p>
        ) : failure ? (
          // 颜色走 --em-*(同 NewSessionComposer 的 blockReason):这棵子树里 --color-* 家族解析为空。
          <p role="alert" className="mt-2 px-1 text-xs text-[var(--em-foreground-destructive)]" data-sample-composer-failure={failure.kind}>
            {translate('projects.sample.convert.failed', { reason: describeSampleConversionFailure(failure, translate) })}
          </p>
        ) : null}
      </div>
    </div>
  );
});

type AgentNotice = { kind: 'none' | 'installing'; text: string } | null;

/**
 * 这台电脑上还没有一个能开任务的智能体时,框下说为什么:正在装(首次引导里选的那家在后台装着)就等它装好,
 * 一个都没有就去框下的智能体选择器里装一个。有一个装好的就不说 —— 用哪一家照新任务的默认(选择器里看得见)。
 * 装没装好还没读回来:先不说,❌ 闪一句「没有」。
 */
function useSampleAgentNotice(): AgentNotice {
  const { translate, locale } = useSessionMessages();
  const { data: agents } = useAgents();
  const { data: statuses } = useAgentInstallationStatuses();
  const installing = useInstallingAgents();
  if (!agents || !statuses) return null;
  const usable = new Set(agents.filter((agent) => sessionpageLegFor(agent.capabilities.sessionpage, 'acp') !== null).map((agent) => agent.id));
  if (statuses.some((status) => status.status === 'available' && usable.has(status.id))) return null;
  const names = agents.filter((agent) => installing.has(agent.id)).map((agent) => agent.name);
  if (names.length > 0) {
    return { kind: 'installing', text: translate('projects.sample.convert.installing', { agents: new Intl.ListFormat(locale, { type: 'conjunction' }).format(names) }) };
  }
  return { kind: 'none', text: translate('projects.sample.convert.noAgent') };
}

export function describeSampleConversionFailure(failure: SampleConversionFailure, translate: Translate): string {
  switch (failure.kind) {
    case 'no-default-directory':
      return translate('projects.sample.convert.noDirectory');
    case 'no-free-folder':
      return translate('projects.sample.convert.noFreeFolder', { name: failure.name });
    case 'create':
      return translate('projects.sample.convert.create', {
        detail: isProjectPathConflictError(failure.error) ? projectPathConflictMessage(failure.error, translate) : messageForUser(failure.error),
      });
    case 'files':
      return translate('projects.sample.convert.files', { detail: messageForUser(failure.error) });
    case 'group':
      return translate('projects.sample.convert.group', { detail: messageForUser(failure.error) });
    case 'row':
      return translate('projects.sample.convert.row');
    case 'record':
      return translate('projects.sample.convert.record', { detail: messageForUser(failure.error) });
    case 'open':
      return translate('projects.sample.convert.open', { detail: messageForUser(failure.error) });
  }
}

/**
 * 变成项目的每一步落到哪:建项目走「新建项目」那一条(CreateProjectNameForm 同一个 createProject,默认项目目录 + 名字),
 * 文件写进项目文件夹,项目群 ensureProjectGroup,这一句经 prepareProjectTask 交给项目的新任务框(和换项目带草稿同一条)。
 */
function sampleConversionHost(userId: string, turn: Omit<ComposerHandoff, 'onCreated'>, translate: Translate): SampleConversionDeps {
  return {
    readKey: () => readSampleProject(userId),
    recordProject: (projectId) => recordSampleProjectConversion(userId, { projectId }),
    recordGroup: (projectId, chatId) => recordSampleProjectConversion(userId, { projectId, chatId }),
    dismiss: () => dismissSampleProject(userId),
    projectExists: (projectId) => getProjectManagerStore().projects.has(projectId),
    defaultDirectory: async () => (await fetchAppSettingsMeta('localProject')).value.defaultProjectsDirectory ?? '',
    pathTaken: async (path) => {
      const inspection = await rpc.projects.inspectProjectPath({ type: 'local', path });
      if (inspection.error) throw new Error(inspection.error.message);
      return inspection.isDirectory || !!inspection.existingProject || !!inspection.pathConflict;
    },
    createProject: async (path, name) => {
      const projectId = await getProjectManagerStore().createProject(
        { type: 'local' },
        { mode: 'pick', path, name, createDirectory: true, allowNonGit: true },
      );
      if (!projectId) throw new Error(translate('projects.create.failed'));
      return projectId;
    },
    projectFolder: async (projectId) => {
      await getProjectManagerStore().ensureMounted(projectId);
      const project = getProjectStore(projectId);
      const workspaceId = asMounted(project)?.data.repositoryWorkspaceId;
      if (!workspaceId) throw new Error(project?.error ?? `project ${projectId} did not open`);
      return workspaceId;
    },
    writeFile: async (projectId, workspaceId, name, text) => {
      const written = await rpc.workspace.files.writeFile(projectId, workspaceId, name, text);
      if (!written.success) throw new Error('message' in written.error ? written.error.message : written.error.type);
    },
    ensureGroup: async (projectId) => {
      const group = await rpc.projects.ensureProjectGroup(projectId);
      if (!group.success) throw new Error(group.error.message);
      return group.data.chatId;
    },
    rowShown: async (projectId, nudge) => {
      // 人又按了一次发送(上次停在这一步):这算人按的重试,可以叫项目表再读一次(account-projects-store 抬头)。
      if (nudge) void accountProjectsStore.refresh();
      try {
        await when(() => accountProjectsStore.projectOfLocal(projectId) !== undefined, { timeout: ROW_WAIT_MS });
        return true;
      } catch {
        return false;
      }
    },
    handOff: (projectId, onCreated) => {
      const draft = composerDrafts.forKey(SAMPLE_DRAFT_KEY);
      draft.setHandoff({ ...turn, onCreated });
      prepareProjectTask(projectId, SAMPLE_DRAFT_KEY);
      if (composerDrafts.forKey(projectDraftKey(projectId)) !== draft) {
        draft.setHandoff(null);
        throw new Error(`project ${projectId} already has an unsent first message`);
      }
      appState.navigation.navigate('project', { projectId });
      forgetSampleProjectOnScreen();
    },
    logError: (message, error) => log.error(`[sample-project] ${message}`, { error: error instanceof Error ? error.message : String(error) }),
  };
}
