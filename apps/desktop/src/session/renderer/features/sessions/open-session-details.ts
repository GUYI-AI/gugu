import { getSessionView } from './stores/session-selectors';

/**
 * Opens a session's 详情 tab beside its conversation, in the session page it is shown in. The card loads this lazily:
 * the tab items that draw the card are themselves registered by the session page's tab registry (a static import would
 * close that loop).
 */
export function openSessionDetails(page: { projectId: string; sessionId: string }, sessionId: string): void {
  const view = getSessionView(page.projectId, page.sessionId);
  if (!view) throw new Error('The session page is not open');
  view.paneLayout.openBeside('session-details', { sessionId });
}
