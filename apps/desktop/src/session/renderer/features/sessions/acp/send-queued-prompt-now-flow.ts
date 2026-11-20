import {
  canOfferDontAskAgain,
  shouldConfirm,
  stopAsking,
} from '@renderer/features/settings/interface-confirm-preference';
import { readDevicePreferences, writeDevicePreferences } from '@/lib/devicePreferences';
import { platform } from '@/platform';
import { toast } from '@renderer/lib/hooks/use-toast';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** Only cancelling a running reply requires confirmation. The preference belongs to the current device. */
export function requestSendQueuedPromptNow(args: { cancelsTurn: boolean; send: () => void }): void {
  const { cancelsTurn, send } = args;
  const nativePhone = platform.kind === 'capacitor';
  const confirm = () => nativePhone
    ? readDevicePreferences().confirmBeforeCancelAndSend !== false
    : shouldConfirm('confirmBeforeCancelAndSend');
  if (!cancelsTurn || !confirm()) {
    send();
    return;
  }
  showModal('confirmActionModal', {
    title: translateSessionMessage('chat.turnInProgress'),
    description: translateSessionMessage('chat.cancelAndSendDescription'),
    confirmLabel: translateSessionMessage('chat.cancelAndSend'),
    variant: 'destructive',
    dontAskAgainLabel: nativePhone
      ? translateSessionMessage('chat.cancelAndSendAlwaysAllow')
      : canOfferDontAskAgain() ? translateSessionMessage('chat.cancelAndSendDontAskAgain') : undefined,
    onSuccess: ({ dontAskAgain }) => {
      if (dontAskAgain && nativePhone) {
        writeDevicePreferences({ confirmBeforeCancelAndSend: false });
        if (readDevicePreferences().confirmBeforeCancelAndSend !== false) {
          toast({ title: translateSessionMessage('chat.cancelAndSendDontAskAgainFailed'), variant: 'destructive' });
        }
      } else if (dontAskAgain) {
        stopAsking('confirmBeforeCancelAndSend', {
          logTag: '[gugu-queue]',
          title: translateSessionMessage('chat.cancelAndSendDontAskAgainFailed'),
          description: translateSessionMessage('chat.cancelAndSendDontAskAgainFailedHint'),
        });
      }
      send();
    },
  });
}
