import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { createRPCController, withSender } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { getProjectWorkspaces } from './operations/getProjectWorkspaces';
import { sessionService } from './session-service';
import { admitFirstMessages } from './session-life-creation';
import { firstTurnFilesPlaced, holdFirstTurnForPlacement } from './first-turn-placement';

/** `deferFirstTurn`: what a page from before #2558 sends for the same thing (another machine may still run one). */
type CreateOptions = { placingFiles?: boolean; deferFirstTurn?: boolean };

/** Prepares the workspace, then admits the creation turns: the first message is queued now, files placed or not. */
async function provisionWorkspace(sessionId: string) {
  const result = await sessionService.provisionWorkspace(sessionId);
  if (result.success) await admitFirstMessages(sessionId);
  return result;
}

/**
 * One device crossing for creation, workspace preparation and admission of the first turn. `placingFiles`: the creating
 * page is still placing the files that turn names, so its dispatch waits for that page (first-turn-placement) — the turn
 * itself is queued here all the same, never held back by the page (#2558).
 */
export async function createAndProvision(params: CreateSessionParams, options: CreateOptions & { sender: number }) {
  const created = await sessionService.createSession(params);
  if (!created.success) return { stage: 'create' as const, result: created };
  const sessionId = params.sessionConfig.initialSession!.id;
  if (options.placingFiles || options.deferFirstTurn) holdFirstTurnForPlacement(sessionId, options.sender);
  try {
    return { stage: 'provision' as const, result: await provisionWorkspace(sessionId) };
  } catch (error) {
    // The row exists. A retry prepares that row, rather than creating another task.
    return { stage: 'provision-error' as const, message: error instanceof Error ? error.message : String(error) };
  }
}

export const sessionCreateController = createRPCController({
  async createSession(params: CreateSessionParams) {
    return sessionService.createSession(params);
  },
  createAndProvisionSession: withSender((sender: number, params: CreateSessionParams, options?: CreateOptions) =>
    createAndProvision(params, { ...options, sender })),
  async getProjectWorkspaces(projectId: string) {
    return getProjectWorkspaces(projectId);
  },
  // The desktop task page's launch of the session it just created: workspace first, then its creation turns.
  provisionWorkspace: (sessionId: string) => provisionWorkspace(sessionId),
  /**
   * The creating page finished placing the first turn's files (all placed or not): its dispatch goes on. The turn was
   * admitted at creation, so admitting again finds it queued under its stable id and adds nothing; the name is the one
   * pages and hosts of every version share (a host from before #2558 deferred the admission to this call).
   */
  admitFirstMessages: async (sessionId: string) => {
    firstTurnFilesPlaced(sessionId);
    await admitFirstMessages(sessionId);
  },
  generateSessionName,
});
