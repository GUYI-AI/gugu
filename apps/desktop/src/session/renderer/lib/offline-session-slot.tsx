import { useCallback, useId, useLayoutEffect, useRef } from 'react';
import { OFFLINE_SESSION_SLOT_PREFIX, readShellSlots } from '@/lib/shellSlots';
import '@/components/session-watch/agent-watch.css';
import '@/components/session-watch/phone-conversation.css';
import '@/components/assistant/assistant-task-chat.css';

/**
 * The page of a task on another machine whose workspace is not ready here (still preparing, or that machine not answering:
 * remoteSessionPageTarget). `label` = why that machine cannot be reached, '' when nothing is known against it.
 * The shell owns the page's Devices/Chat/Auth contexts; the embedded gate owns its placement.
 */
export function OfflineSessionSlot({ sessionId, deviceId, label }: { sessionId: string; deviceId: string; label: string }) {
  const id = useId();
  const target = [sessionId, deviceId].map(encodeURIComponent).join('/');
  const key = `${OFFLINE_SESSION_SLOT_PREFIX}${target}/${id}`;
  const element = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    element.current = node;
    if (!node) readShellSlots()?.setSlot(key, null);
  }, [key]);
  useLayoutEffect(() => {
    if (element.current) readShellSlots()?.setSlot(key, element.current, label);
  }, [key, label]);
  return <div ref={ref} data-offline-session={sessionId} className="flex h-full min-h-0 w-full flex-col" />;
}
