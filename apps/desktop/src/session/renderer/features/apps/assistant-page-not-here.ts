import { useEffect } from 'react';
import { ASSISTANT_APP_ID, openAssistantEntry, useAssistantEntryTarget } from '@/lib/assistantEntry';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';

/**
 * The assistant App's page, restored by the window (or opened by an old link) while the App is not here to draw it: not installed
 * yet (the ensure step is putting it in) or switched off by the person. For this App the line 「switched off — turn it on in Apps」
 * is wrong — it is on its way, and the rail's top cell says so — and the page has nothing of its own to show. It is one more
 * route into the assistant, so it asks the one decision (lib/assistantEntry.ts): the assistant's chat as any chat while the App is not
 * usable here, or Settings' setup when there is no assistant. Only once the installed Apps are read: until then "not here" may mean
 * "not read yet", and a good restore must not be sent away. Answers whether the page is in that state, to say it is getting ready.
 */
export function useAssistantPageNotHere(appId: string | undefined, drawn: boolean): boolean {
  const target = useAssistantEntryTarget();
  const loaded = installedExtensionsStore.isLoaded;
  const notHere = appId === ASSISTANT_APP_ID && !drawn && target.kind !== 'app';
  useEffect(() => {
    if (notHere && loaded) openAssistantEntry();
  }, [notHere, loaded, target.kind]);
  return notHere;
}
