import { isAssistantSession } from '@renderer/features/assistant/assistant-lineage';
import type { AssistantShellSnapshot } from '@/lib/assistantShellBridge';
import type { DeviceSessions } from '@/session/shared/remote-sessions/session-directory';

// GUYI-AI/gugu#2548 the one list's empty state: while the list has no tasks yet it says what will appear there, and when
// this computer also has sessions from other tools that were never imported, it offers to import them (it opens the
// import part of 会话历史). A fact not known yet = not shown: a note that shows and then goes is worse than one that
// comes a moment later.

/**
 * Whose conversations are not tasks: the personal assistant's own (it lives on the rail, not in the task area, #7199).
 * `undefined` = not known yet (the shell has not said, or could not read it); null = this account has no assistant.
 */
export function assistantOf(shell: Pick<AssistantShellSnapshot, 'assistantState' | 'assistant'> | null): string | null | undefined {
  if (shell?.assistantState === 'none') return null;
  if (shell?.assistantState === 'found' && shell.assistant) return shell.assistant.id;
  return undefined;
}

/**
 * Does the list have no tasks yet: no session on any of my machines, the assistant's own aside. Read from the same
 * cross-machine session directory the list places my agents from (lib/sidebarOneList, agentTaskHomes). A session with no
 * agent on it is still a task. null = not known yet: the machines are not published, or there are sessions and it is not
 * known yet which of them are the assistant's.
 */
export function listHasNoTasks(
  machines: readonly Pick<DeviceSessions, 'sessions'>[],
  assistantId: string | null | undefined,
): boolean | null {
  if (machines.length === 0) return null;
  const sessions = machines.flatMap((machine) => machine.sessions);
  if (sessions.length === 0) return true;
  if (assistantId === undefined) return null;
  return sessions.every((session) => isAssistantSession(session, assistantId));
}

/**
 * The offer shows when the list has no tasks and this computer has sessions in 会话历史's import part.
 * `importable` = how many sections that part lists on this computer (null = not read yet).
 */
export function importOfferShown(noTasks: boolean | null, importable: number | null): boolean {
  return noTasks === true && importable !== null && importable > 0;
}

