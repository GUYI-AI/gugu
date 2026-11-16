import { events } from '@main/lib/events';
import { importedThemePacksChangedChannel } from '@shared/events/appEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isThemePack, type ThemePack } from '@shared/theme/theme-packs';
import { reconcileSettingsRuntimeState } from './controller';
import { readImportedThemePacks, writeImportedThemePacks } from './device-settings';
import { appSettingsService } from './settings-service';

/**
 * @@@theme-pack-slots — this device's imported theme packs (a file under userData) and the stylesheet main derives from
 * the stored slots. The slots themselves are the `themePackSlots` app setting.
 */
export const themePacksController = createRPCController({
  imported: async (): Promise<ThemePack[]> => readImportedThemePacks(),

  /** Import (or replace, same id) one pack; answers the list as stored. */
  saveImported: async (pack: ThemePack): Promise<ThemePack[]> => {
    if (!isThemePack(pack)) throw new Error('not a theme pack');
    const next = [...readImportedThemePacks().filter((p) => p.id !== pack.id), pack];
    writeImportedThemePacks(next);
    events.emit(importedThemePacksChangedChannel, undefined);
    return next;
  },

  /** Remove one imported pack; a slot that named it goes back to Gugu's own colours. Answers the list as stored. */
  removeImported: async (id: string): Promise<ThemePack[]> => {
    const next = readImportedThemePacks().filter((p) => p.id !== id);
    writeImportedThemePacks(next);
    const slots = appSettingsService.getWithMetaNow('themePackSlots').value;
    if (slots.light === id || slots.dark === id) {
      const kept = { ...slots };
      if (kept.light === id) delete kept.light;
      if (kept.dark === id) delete kept.dark;
      await appSettingsService.update('themePackSlots', kept);
      await reconcileSettingsRuntimeState('themePackSlots');
    }
    events.emit(importedThemePacksChangedChannel, undefined);
    return next;
  },
});
