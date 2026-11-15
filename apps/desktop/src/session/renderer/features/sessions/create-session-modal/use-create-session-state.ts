import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { queryClient } from '@/lib/replica';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { rpc } from '@renderer/lib/ipc';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { getIssueSessionName } from './issue-session-name';
import { useSessionName } from './use-session-name';
import { useWorkspaceConfig } from './use-workspace-config';

export type LinkedType = 'issue' | 'pr' | null;

type NameRequest = { key: string; input: { title?: string; description?: string } };

export type CreateSessionState = ReturnType<typeof useCreateSessionState>;

export function useCreateSessionState(
  projectId: string | undefined,
  repositoryWorkspaceId: string | null | undefined,
  initialPR?: PullRequest,
  initialLinkedType: LinkedType = null,
  opts?: {
    /**
     * Callers that render no task-name input (新建任务 整页 composer) must always get a
     * generated name. `autoGenerateName` defaults to false and only means "pre-fill the
     * modal's name field" — with no field to fill, honouring it leaves effectiveSessionName
     * permanently '' → isValid false → 发送键永远置灰、回车无反应 (owner: 对话都没法对话).
     */
    requireGeneratedName?: boolean;
    /**
     * 会话直接跑在项目目录里,不替它另开 worktree(owner: session 就是 task,不用在外面多套
     * 一层;各家 agent 自己会开 worktree,gugu 再 fork 一层是重复劳动)。
     * 走 repo-root 预设 = git kind 'none' + 项目自己的 repository-instance,于是分支冲突、
     * 空仓库无法建分支这些创建前置校验全部不存在 —— 创建这个动作不再可能失败。
     */
    runInProjectDir?: boolean;
  }
) {
  const sessionSettings = useSessionSettings();
  // null = the setting is not read yet: nothing is generated and the name stays pending until it is.
  const autoGenerateName: boolean | null = opts?.requireGeneratedName === true ? true : sessionSettings && sessionSettings.autoGenerateName;

  const [linkedType, setLinkedTypeRaw] = useState<LinkedType>(initialPR ? 'pr' : initialLinkedType);
  const [linkedIssue, setLinkedIssueRaw] = useState<LinkedIssue | null>(null);
  const [linkedPR, setLinkedPRRaw] = useState<PullRequest | null>(initialPR ?? null);
  const [prevProjectId, setPrevProjectId] = useState(projectId);

  // Reset linked state when project changes.
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId);
    setLinkedTypeRaw(null);
    setLinkedIssueRaw(null);
    setLinkedPRRaw(null);
  }

  // Stable random key for the "plain task" name generation — one per modal session.
  const randomKey = useMemo(() => crypto.randomUUID(), []);

  const hasLinkedEntity =
    (linkedType === 'issue' && linkedIssue !== null) || (linkedType === 'pr' && linkedPR !== null);
  // Issue-derived name (Linear can derive directly from branchName; others need AI)
  const directIssueSessionName = getIssueSessionName(linkedIssue);

  /**
   * The name suggestion this box asks for now, or null when it asks for none (the setting is off or not read yet, or an
   * issue names the task itself). A suggestion is an LLM command whose answer fills an input the person can edit:
   * asked once per request, never read again as data (PLAN-REVIEW Q6).
   */
  const request = useMemo((): NameRequest | null => {
    if (autoGenerateName !== true) return null;
    if (linkedType === 'issue' && linkedIssue !== null) {
      return directIssueSessionName !== null ? null : {
        key: `issue\u0000${linkedIssue.title}\u0000${linkedIssue.description ?? ''}`,
        input: { title: linkedIssue.title, description: linkedIssue.description },
      };
    }
    if (linkedType === 'pr' && linkedPR !== null) {
      return {
        key: `pr\u0000${linkedPR.title}\u0000${linkedPR.description ?? ''}`,
        input: { title: linkedPR.title, description: linkedPR.description ?? undefined },
      };
    }
    return hasLinkedEntity ? null : { key: `random\u0000${randomKey}`, input: {} };
  }, [autoGenerateName, linkedType, linkedIssue, linkedPR, directIssueSessionName, hasLinkedEntity, randomKey]);

  const generate = useMutation({
    mutationFn: (asked: NameRequest) => rpc.sessionCreate.generateSessionName(asked.input),
  }, queryClient);
  const { mutate } = generate;
  // @@@effect-flow - asks the model for a task-name suggestion (a command, once per request); its answer fills an editable input
  useEffect(() => {
    if (request) mutate(request);
  }, [request?.key, mutate]);
  const answeredThis = request !== null && generate.variables?.key === request.key;
  const suggestion = answeredThis && generate.isSuccess ? generate.data : undefined;

  // Pick the effective generated name and pending state based on linked type + selection.
  const generatedName = linkedType === 'issue' && linkedIssue !== null && directIssueSessionName !== null
    ? directIssueSessionName
    : suggestion;
  // Not read yet, or asked and not answered: pending. A failed suggestion is not pending (the input is left to fill).
  const isPending = autoGenerateName === null
    || (request !== null && !(answeredThis && (generate.isSuccess || generate.isError)));

  const sessionName = useSessionName({
    generatedName,
    isPending,
    resetKey: projectId,
  });

  const workspaceConfig = useWorkspaceConfig({ repositoryWorkspaceId });

  // Switching linked type clears the selection for the previous type.
  const setLinkedType = (type: LinkedType) => {
    setLinkedTypeRaw(type);
  };

  const setLinkedIssue = (issue: LinkedIssue | null) => {
    setLinkedIssueRaw(issue);
  };

  const setLinkedPR = (pr: PullRequest | null) => {
    setLinkedPRRaw(pr);
  };

  // Issue/PR selection is optional enrichment — not required for creation.
  const isValid =
    sessionName.effectiveSessionName.trim().length > 0 && !sessionName.isPending && workspaceConfig.isValid;

  return {
    linkedType,
    setLinkedType,
    linkedIssue,
    setLinkedIssue,
    linkedPR,
    setLinkedPR,
    sessionName,
    workspaceConfig,
    isValid,
  };
}
