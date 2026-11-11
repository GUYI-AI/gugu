import { z } from 'zod';

/**
 * #1925 (API 46) One host layer over an App's panel, one at a time: a page of the host's own, drawn by the host where the
 * App's page is (the App's page set aside, kept as it was), with a back control of the host's that takes it away. Opening
 * one closes the one before. Each kind is one host page:
 *   · `work`               — one task's conversation of the person's own assistant (`gugu.bindings.openWork`);
 *   · `assistant-settings` — the assistant's settings page (the gear of the host's row, `conversationSurface.header`).
 * More kinds of the assistant's own pages join this list (API 44: `assistant-projects`, `assistant-capabilities`).
 *
 * The App hears only that a host page is open or not (`gugu.bindings.surface` → `panel.hostPage`, and `onSurface`), and with
 * `chat:work` which of its rows is open (`gugu.bindings.work` → `open`) — never what a page shows.
 */
export const APP_HOST_LAYER_KINDS = ['work', 'assistant-settings'] as const;
export type AppHostLayerKind = (typeof APP_HOST_LAYER_KINDS)[number];
/** The kinds that are one fixed host page, opened for the account alone (no row of the App's). */
export const APP_HOST_LAYER_PAGES = ['assistant-settings'] as const satisfies readonly AppHostLayerKind[];
export type AppHostLayerPage = (typeof APP_HOST_LAYER_PAGES)[number];

/** A layer open over an App's panel as main keeps it: which page, the account it was opened for, and a task's ids (`work`). */
export type AppHostLayerShown = { kind: 'work'; ownerId: string; workId: string; sessionId: string } | { kind: AppHostLayerPage; ownerId: string };

/** The window's word on the layer over one App's panel now (null: none), each time it opens or closes (`reportHostLayer`). */
export const appHostLayerReportSchema = z.strictObject({
  extensionId: z.string().min(1).max(200),
  layer: z.union([
    z.strictObject({ kind: z.literal('work'), ownerId: z.string().uuid(), workId: z.string().uuid(), sessionId: z.string().min(1).max(200) }),
    z.strictObject({ kind: z.enum(APP_HOST_LAYER_PAGES), ownerId: z.string().uuid() }),
  ]).nullable(),
});
export type AppHostLayerReport = z.infer<typeof appHostLayerReportSchema>;
