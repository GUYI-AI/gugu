import { codexStartupKind } from '@gugu/core/local/codex-startup-failure.mjs';
import type { SessionTranslate } from './stores/session-failure-message';
import type { SessionFailure } from './stores/session-failure';

/** Known startup diagnostics have a specific repair; unknown diagnostics stay in the log. */
export function codexNeedsUpgrade(reason: unknown): boolean {
  return codexStartupKind(reason) === 'version';
}

export function isCodexStartupFailure(reason: unknown): boolean { return codexStartupKind(reason) !== null; }

export function sessionStartupFailureCopy(reason: unknown, translate: SessionTranslate): string {
  const kind = codexStartupKind(reason);
  if (kind === null) return translate('taskError.startFailedRetry');
  const copy = { version: 'taskError.codexUpgrade', missing: 'taskError.codexMissing',
    permission: 'taskError.codexPermission', configuration: 'taskError.codexConfiguration',
    protocol: 'taskError.codexProtocol', exited: 'taskError.codexExited', timeout: 'taskError.codexTimeout',
    unknown: 'taskError.codexStartFailed' } as const;
  return translate(copy[kind]);
}

/** Creation errors are application failures, unlike raw failed-turn contents in the transcript. */
export function creationFailureCopy(failure: SessionFailure, translate: SessionTranslate): string {
  switch (failure.kind) {
    case 'attachment-host-update-required': return translate('composer.attachmentHostUpdateRequired');
    case 'raw': return isCodexStartupFailure(failure) ? sessionStartupFailureCopy(failure, translate) : translate('taskError.createFailedRetry');
    case 'harness-unavailable': return translate(failure.reason === 'updating' ? 'taskError.harnessUpdating' : 'taskError.harnessMissing', { harnessName: failure.harnessName });
    case 'project-not-found': return translate('taskError.createProjectMissing');
    case 'workspace-no-intent':
    case 'workspace-missing': return translate('taskError.createWorkspaceMissing');
    case 'setup-step-failed': return translate('taskError.createSetupFailed');
    case 'provision-timeout': return translate('taskError.createTimedOut');
  }
}
