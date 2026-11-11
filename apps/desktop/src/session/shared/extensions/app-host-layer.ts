import { z } from 'zod';

/**
 * #1925 (API 44) One host layer over an App's panel, one open at a time: a page of the host's own, drawn by the host where
 * the App's page is (the page set aside, kept as it was), with a back control of the host's that takes it away. The App
 * asks for one through a verb of its own (`gugu.assistant.open(name, "settings" | "projects" | "capabilities")`), checked
 * by main; it hears only that a host page is open or closed, never what the page shows. Each kind is one host page.
 */
export const APP_HOST_LAYER_KINDS = ['assistant-settings', 'assistant-projects', 'assistant-capabilities'] as const;
export type AppHostLayerKind = (typeof APP_HOST_LAYER_KINDS)[number];

/** A layer open over an App's panel: which page, and the account main checked it for. */
export type AppHostLayer = { kind: AppHostLayerKind; ownerId: string };

/** The window's word on the layer over one App's panel now (null: none), each time it opens or closes. */
export const appHostLayerReportSchema = z.strictObject({
  extensionId: z.string().min(1).max(200),
  layer: z.strictObject({ kind: z.enum(APP_HOST_LAYER_KINDS), ownerId: z.string().uuid() }).nullable(),
});
export type AppHostLayerReport = z.infer<typeof appHostLayerReportSchema>;
