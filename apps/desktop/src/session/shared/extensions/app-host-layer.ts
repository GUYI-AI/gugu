import { z } from 'zod';

/**
 * #1925 One host layer over an App's panel, one at a time: a page of the host's own, drawn by the host where the App's page
 * is (the App's page set aside, kept as it was), with a back control of the host's that takes it away. Opening one closes the
 * one before. Each kind is one host page:
 *   · `work` (46)                — one task's conversation of the person's own assistant (`gugu.bindings.openWork`);
 *   · `assistant-settings` (44, 46) — the assistant's settings page (`gugu.assistant.open(name, "settings")`, or the gear of
 *                                   the host's row above the conversation, `conversationSurface.header`);
 *   · `assistant-setup` (44)       — the setup guide while there is no assistant yet (`gugu.assistant.open(name, "setup")`,
 *                                   or the host's own routes to set it up); closed once the assistant is there;
 *   · `assistant-connected-apps` (44) — the apps connected to it (`gugu.assistant.open(name, "connected-apps")`, or the
 *                                   host's own routes to them);
 *   · `assistant-projects`, `assistant-capabilities` (44) — the assistant panel's own pages (`gugu.assistant.open`).
 * None of these is in Settings: everything about the assistant lives in its App.
 *
 * The App hears only that a host page is open or not — `panel.hostPage` (`gugu.bindings.surface` / `onSurface`) and
 * `hostPage` (`gugu.assistant.status` / `onChanged`) — and with `chat:work` which of its rows is open (`gugu.bindings.work` →
 * `open`); never what a page shows.
 */
export const APP_HOST_LAYER_PAGES = ['assistant-setup', 'assistant-settings', 'assistant-connected-apps', 'assistant-projects', 'assistant-capabilities'] as const;
export type AppHostLayerPage = (typeof APP_HOST_LAYER_PAGES)[number];
export const APP_HOST_LAYER_KINDS = ['work', ...APP_HOST_LAYER_PAGES] as const;

/** The assistant page a request names, drawn over the App's panel: which host page (`found`: the assistant is there now). */
export type AssistantPageRequest = 'setup' | 'settings' | 'move' | 'connected-apps' | 'projects' | 'capabilities';
export function assistantLayerPage(request: AssistantPageRequest, found: boolean): AppHostLayerPage {
  switch (request) {
    // With no assistant yet, setting it up; once there is one, its settings page (as Settings' 咕咕 page drew either).
    case 'setup': return found ? 'assistant-settings' : 'assistant-setup';
    // The move group is on the settings page.
    case 'move':
    case 'settings': return 'assistant-settings';
    case 'connected-apps': return 'assistant-connected-apps';
    case 'projects': return 'assistant-projects';
    case 'capabilities': return 'assistant-capabilities';
  }
}

/** Whether a host page can be drawn for the assistant as it is: the setup guide only while there is none, the rest only once there is one. */
export const assistantLayerPageShown = (page: AppHostLayerPage, found: boolean): boolean => (page === 'assistant-setup') !== found;
export type AppHostLayerKind = (typeof APP_HOST_LAYER_KINDS)[number];

/** A layer open over an App's panel as main keeps it: which page, the account it was opened for, and a task's ids (`work`). */
export type AppHostLayer = { kind: 'work'; ownerId: string; workId: string; sessionId: string } | { kind: AppHostLayerPage; ownerId: string };
/** The same, by the name the work binding (46) gave it. */
export type AppHostLayerShown = AppHostLayer;

/** The window's word on the layer over one App's panel now (null: none), each time it opens or closes (`reportHostLayer`). */
export const appHostLayerReportSchema = z.strictObject({
  extensionId: z.string().min(1).max(200),
  layer: z.union([
    z.strictObject({ kind: z.literal('work'), ownerId: z.string().uuid(), workId: z.string().uuid(), sessionId: z.string().min(1).max(200) }),
    z.strictObject({ kind: z.enum(APP_HOST_LAYER_PAGES), ownerId: z.string().uuid() }),
  ]).nullable(),
});
export type AppHostLayerReport = z.infer<typeof appHostLayerReportSchema>;
