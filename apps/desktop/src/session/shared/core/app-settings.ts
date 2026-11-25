import type z from 'zod';
import {
  appSettingsSchema,
  type changesViewModeSchema,
  type newSessionMemorySchema,
  type projectSettingsSchema,
  type providerCustomConfigEntrySchema,
  type sessionSettingsSchema,
} from '@main/core/settings/schema';
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type ProviderCustomConfig = z.infer<typeof providerCustomConfigEntrySchema>;
export type ChangesViewMode = z.infer<typeof changesViewModeSchema>;
export type NewSessionMemory = z.infer<typeof newSessionMemorySchema>;
export type ChangesSection = keyof ChangesViewMode;
export type ChangesListViewMode = ChangesViewMode[ChangesSection];
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsKey = keyof AppSettings;

export const AppSettingsKeys = Object.keys(appSettingsSchema.shape) as AppSettingsKey[];
