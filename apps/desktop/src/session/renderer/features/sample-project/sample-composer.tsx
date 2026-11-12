import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { setComposerVerb } from '@/lib/composerVerbBridge';
import {
  dismissSampleProject,
  readSampleProject,
  recordSampleProjectConversion,
} from '@/lib/sampleProject';
import { forgetSampleProjectOnScreen } from '@renderer/app/screen-layout-actions';
import { openChatOnScreen } from '@renderer/features/chats/open-chat';
import { prepareProjectTask } from '@renderer/features/projects/project-task-entry';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { asMounted, getProjectManagerStore, getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { composerDrafts, projectDraftKey, type ComposerHandoff } from '@renderer/features/sessions/composer-drafts';
import { composerVerbLook } from '@renderer/features/sessions/composer-verb-tag';
import { NewSessionComposer } from '@renderer/features/sessions/new-session-page';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName } from '@renderer/features/sessions/session-composer-styles';
import { fetchAppSettingsMeta } from '@renderer/features/settings/app-settings-client';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { useAgentInstallationStatuses, useInstallingAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { sessionpageLegFor } from '@shared/core/sessions/provider-selection';
import type { SampleProjectContent } from './content/types';
import { convertSampleProject, sampleConversionOf, type SampleConversionDeps, type SampleConversionFailure } from './sample-conversion';
import { whenGroupRowShown } from './sample-group-row';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

/** 示例那一框写了一半的话暂存在这一格;变成项目那一刻整格挪进那个项目的新任务框(prepareProjectTask)。 */
export const SAMPLE_DRAFT_KEY = 'sample-project';

/** 示例变成项目之后,要等它那一行出现在左侧列表里多久(群进聊天列表、项目表重读)。 */
const ROW_WAIT_MS = 20_000;

/**
 * #2569 示例底下是和项目里一样的新任务框(同一个 NewSessionComposer:智能体、模型、权限照新任务的默认)。
 * 还没有项目,所以按发送 = 先把示例变成这个人自己的项目(sample-conversion),再由那个项目的新任务框把这一句发出去。
 * 发不了要说为什么:还没有装好的智能体、正在装;变的哪一步没成、接下来能怎么做(原因进日志);❌ 只把发送键灰掉。
 */
export const SampleComposer = observer(function SampleComposer({ ownerId, content }: { ownerId: string; content: SampleProjectContent }) {
  const { translate, locale } = useSessionMessages();
  const agentNotice = useSampleAgentNotice();
  const name = translate('projects.sample.name');
  const verb = useMemo(() => composerVerbLook('task', { label: translate('taskDispatch.task') }), [translate]);
  const progress = sampleConversionOf(ownerId);
  const working = progress.status === 'working';
  const failure = progress.failure;
  const send = (input: InitialSessionState) => {
    if (!input.provider) return;
    const request = content.messages.find((message) => message.kind === 'task')?.text ?? '';
    const files = new Intl.ListFormat(locale, { type: 'conjunction' }).format(content.files.map((file) => file.name));
    const turn: ComposerHandoff = {
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
            {sampleConversionFailureLine(failure, translate)}
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

/** 哪一步没成,框下那一句说接下来能怎么做;内部原因只进日志(convertSampleProject 记)。 */
export function sampleConversionFailureLine(failure: SampleConversionFailure, translate: Translate): string {
  switch (failure.kind) {
    case 'no-default-directory':
      return translate('projects.sample.convert.noDirectory');
    case 'no-free-folder':
      return translate('projects.sample.convert.noFreeFolder', { name: failure.name });
    case 'create':
      return translate('projects.sample.convert.create');
    case 'files':
      return translate('projects.sample.convert.files');
    case 'group':
      return translate('projects.sample.convert.group');
    case 'row':
      return translate('projects.sample.convert.row');
    case 'record':
      return translate('projects.sample.convert.record');
    case 'open':
      return translate('projects.sample.convert.open');
  }
}

/**
 * 变成项目的每一步落到哪:建项目走「新建项目」那一条(CreateProjectNameForm 同一个 createProject,默认项目目录 + 名字),
 * 文件写进项目文件夹,项目群 ensureProjectGroup,这一句经 prepareProjectTask 交给项目的新任务框(和换项目带草稿同一条)。
 */
function sampleConversionHost(userId: string, turn: ComposerHandoff, translate: Translate): SampleConversionDeps {
  return {
    owner: userId,
    signedIn: () => readAssistantShellBridge()?.getSnapshot()?.ownerId === userId,
    readKey: () => readSampleProject(userId),
    recordProject: (projectId) => recordSampleProjectConversion(userId, { projectId }),
    recordGroup: (projectId, chatId) => recordSampleProjectConversion(userId, { projectId, chatId }),
    dismiss: () => dismissSampleProject(userId),
    // 项目已经交出去了,示例那一块不在了:框下说不了,用一条提示说(下次读键时会再删,见 use-sample-project)。
    dismissFailed: () => toast({ tier: 'error', title: translate('projects.sample.dismissFailed'), description: translate('projects.sample.dismissFailedHint') }),
    projectExists: (projectId) => getProjectManagerStore().projects.has(projectId),
    defaultDirectory: async () => (await fetchAppSettingsMeta('localProject')).value.defaultProjectsDirectory ?? '',
    pathTaken: async (path) => {
      const inspection = await rpc.projects.inspectProjectPath({ type: 'local', path });
      if (inspection.error) throw new Error(inspection.error.message);
      // 那里是个文件,也建不了文件夹:让给下一个名字(❌ 每次重试都在同一个名字上失败)。
      return inspection.isDirectory || !!inspection.isFile || !!inspection.existingProject || !!inspection.pathConflict;
    },
    createProject: async (path, name) => {
      const projectId = await getProjectManagerStore().createProject(
        { type: 'local' },
        { mode: 'pick', path, name, createDirectory: true, allowNonGit: true },
      );
      if (!projectId) throw new Error(`creating the project at ${path} did not complete`);
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
    whenRowShown: (chatId, nudge, open) => {
      // 人又按了一次发送(上次停在这一步):这算人按的重试,可以叫项目表再读一次(account-projects-store 抬头)。
      if (nudge) void accountProjectsStore.refresh();
      return whenGroupRowShown(chatId, open, ROW_WAIT_MS);
    },
    handOff: (projectId) => {
      const draft = composerDrafts.forKey(SAMPLE_DRAFT_KEY);
      draft.setHandoff(turn);
      prepareProjectTask(projectId, SAMPLE_DRAFT_KEY);
      if (composerDrafts.forKey(projectDraftKey(projectId)) !== draft) {
        draft.setHandoff(null);
        throw new Error(`project ${projectId} already has an unsent first message`);
      }
      appState.navigation.navigate('project', { projectId });
      forgetSampleProjectOnScreen();
    },
    // 项目在别的电脑上,这台电脑没有它的文件夹:和点它那一行一样打开它的群,这一句带进群里的新任务框(派到哪台电脑由人在那里选)。
    // 交过去的只有这一句话:示例的说明进不了那一框,示例的文件在那台电脑的项目文件夹里。
    handOffToGroup: (chatId) => {
      const words = composerDrafts.get(SAMPLE_DRAFT_KEY);
      setComposerVerb(chatId, 'task', words, { name: accountProjectsStore.project(chatId)?.name ?? '', joinable: true, inGroup: true });
      openChatOnScreen(chatId, false);
      forgetSampleProjectOnScreen();
      composerDrafts.discard(SAMPLE_DRAFT_KEY);
    },
    logError: (message, error) => log.error(`[sample-project] ${message}`, { error: error instanceof Error ? error.message : String(error) }),
  };
}
