import { useCallback, useSyncExternalStore } from 'react';
import { appWorkSlotKey, readAppWorkChatBridge } from '@/lib/appWorkChatBridge';
import { readShellSlots } from '@/lib/shellSlots';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';

const noop = () => () => undefined;

/** #1925 (API 46) Whether the host draws one of the assistant's tasks in this App's panel now (`gugu.bindings.openWork`). */
export function useAppWorkChatOpen(extensionId: string): boolean {
  const bridge = readAppWorkChatBridge();
  const open = () => Object.hasOwn(bridge?.getSnapshot() ?? {}, extensionId);
  return useSyncExternalStore(bridge?.subscribe ?? noop, open, open);
}

/**
 * The cell the shell draws that task's conversation into (AppWorkLedgerHost): the built-in task window, with its own back
 * control — the built-in panel's `task-chat` cell, in the App's panel. The App's page is set aside meanwhile, never closed.
 */
export function AppWorkChatSlot({ extensionId }: { extensionId: string }) {
  const cell = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(appWorkSlotKey(extensionId), element), [extensionId]);
  return <div ref={cell} className="ta-task-chat-slot" data-testid="app-work-chat" />;
}

/**
 * The App's page in its own view (`tabId` "dock"), or — while one of its tasks is open — that task's conversation in its
 * place, for a page not placed beside a conversation (`AppConversationFrame` does the same in its panel).
 */
export function AppDockPage({ extensionId, tabKind }: { extensionId: string; tabKind: string }) {
  const workOpen = useAppWorkChatOpen(extensionId);
  if (!workOpen) return <ExtensionSharedSlot tabKind={tabKind} tabId="dock" />;
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-ta-scope="">
      <AppWorkChatSlot extensionId={extensionId} />
    </div>
  );
}
