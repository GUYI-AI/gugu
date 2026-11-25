import { customModelRefFromOption, type CustomModelRef } from '@gugu/session-core/models/custom-model';
import { isCodexOfficialApiEndpoint } from './harness-connection-launch';

/** A built-in provider cannot share its key with a managed provider. The official API also
 * rejects encrypted reasoning received from the Gugu gateway, even under a shared key. */
export async function codexChannelSwitchNeedsNewThread(input: {
  previousPlatform: boolean;
  previousCustom?: CustomModelRef;
  target: 'platform' | 'own';
  targetModel: string | null;
  customEndpoint: (ref: CustomModelRef) => Promise<string>;
}): Promise<boolean> {
  const targetCustom = input.target === 'own' ? customModelRefFromOption(input.targetModel) : null;
  const previousNative = !input.previousPlatform && !input.previousCustom;
  const targetNative = input.target === 'own' && !targetCustom;
  if (previousNative !== targetNative) return true;
  if (!targetCustom || (!input.previousPlatform && targetCustom.connectionId === input.previousCustom?.connectionId)) return false;
  return isCodexOfficialApiEndpoint(await input.customEndpoint(targetCustom));
}
