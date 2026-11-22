import { computeCheckRunsSummary } from '@renderer/utils/github';
import { translateSessionMessage as t } from '@renderer/localization/locale-store';
import type { PullRequest, PullRequestCheck } from '@shared/core/pull-requests/pull-requests';

export type MergeSeverity = 'success' | 'warning' | 'error' | 'neutral';
export type MergeCheckState = 'pending' | 'failed' | 'passing' | 'unknown';

export type MergeUiState = {
  kind: 'ready' | 'draft' | 'conflicts' | 'behind' | 'blocked' | 'unstable' | 'unknown';
  severity: MergeSeverity;
  title: string;
  detail?: string;
  canMerge: boolean;
  canBypassRequirements: boolean;
};

export function deriveMergeCheckState(checks: PullRequestCheck[]): MergeCheckState {
  const summary = computeCheckRunsSummary(checks);
  if (summary.failed > 0) return 'failed';
  if (summary.pending > 0) return 'pending';
  if (summary.passed > 0) return 'passing';
  return 'unknown';
}

export function computeMergeUiState(pr: PullRequest): MergeUiState {
  if (pr.status !== 'open') {
    return {
      kind: 'unknown',
      severity: 'neutral',
      title: t('pr.mergeState.unknown'),
      detail: t('pr.mergeState.closedHint'),
      canMerge: false,
      canBypassRequirements: false,
    };
  }
  if (pr.isDraft) {
    return {
      kind: 'draft',
      severity: 'neutral',
      title: t('pr.mergeState.draft'),
      detail: t('pr.mergeState.draftHint'),
      canMerge: false,
      canBypassRequirements: false,
    };
  }
  switch (pr.mergeStateStatus) {
    case 'CLEAN':
      return {
        kind: 'ready',
        severity: 'success',
        title: t('pr.mergeState.ready'),
        detail: t('pr.mergeState.readyHint'),
        canMerge: true,
        canBypassRequirements: false,
      };
    case 'DIRTY':
      return {
        kind: 'conflicts',
        severity: 'error',
        title: t('pr.mergeState.conflicts'),
        detail: t('pr.mergeState.conflictsHint'),
        canMerge: false,
        canBypassRequirements: false,
      };
    case 'BEHIND':
      return {
        kind: 'behind',
        severity: 'warning',
        title: t('pr.mergeState.behind'),
        detail: t('pr.mergeState.behindHint'),
        canMerge: false,
        canBypassRequirements: true,
      };
    case 'BLOCKED':
      return {
        kind: 'blocked',
        severity: 'error',
        title: t('pr.mergeState.blocked'),
        detail: t('pr.mergeState.blockedHint'),
        canMerge: false,
        canBypassRequirements: true,
      };
    case 'HAS_HOOKS':
      return {
        kind: 'blocked',
        severity: 'error',
        title: t('pr.mergeState.blocked'),
        detail: t('pr.mergeState.hooksHint'),
        canMerge: false,
        canBypassRequirements: true,
      };
    case 'UNSTABLE':
      switch (deriveMergeCheckState(pr.checks)) {
        case 'pending':
          return {
            kind: 'unstable',
            severity: 'warning',
            title: t('pr.mergeState.checksRunning'),
            detail: t('pr.mergeState.checksRunningHint'),
            canMerge: false,
            canBypassRequirements: true,
          };
        case 'failed':
          return {
            kind: 'unstable',
            severity: 'warning',
            title: t('pr.mergeState.checksFailing'),
            detail: t('pr.mergeState.checksFailingHint'),
            canMerge: false,
            canBypassRequirements: true,
          };
        case 'passing':
          return {
            kind: 'unstable',
            severity: 'warning',
            title: t('pr.mergeState.unstable'),
            detail: t('pr.mergeState.unstableHint'),
            canMerge: false,
            canBypassRequirements: true,
          };
        case 'unknown':
          return {
            kind: 'unstable',
            severity: 'warning',
            title: t('pr.mergeState.checksUnknown'),
            detail: t('pr.mergeState.checksUnknownHint'),
            canMerge: false,
            canBypassRequirements: true,
          };
      }
    // falls through — 内层 switch 按类型是穷尽的,漏网的走下面的 unknown。
    default:
      return {
        kind: 'unknown',
        severity: 'neutral',
        title: t('pr.mergeState.unknown'),
        detail: t('pr.mergeState.retryHint'),
        canMerge: false,
        canBypassRequirements: false,
      };
  }
}
