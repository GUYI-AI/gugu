import { events } from '@main/lib/events';
import { extensionsInventoryChangedChannel } from '@shared/extensions/marketEvents';
import { ASSISTANT_RULES_PROVIDER_ID } from '../../../../assistant-rules-trust';

/**
 * Entry switch: whether #1931's ensure step (assistant-rules-root.ts `ensureAssistantApp`) is putting the trusted assistant
 * App in right now. While it is, the assistant's entry on the rail shows its「准备中」(assistant-app-entry.ts answers it to
 * the window). `true` when an attempt starts; `false` once it is in, not needed, or stuck — a stuck install is not shown as
 * preparing forever. The window hears a change as a change of that App and asks again. Kept apart, free of the binding
 * code, so the start path that runs the ensure step loads nothing more.
 */
let ensuring = false;

export function noteAssistantAppEnsuring(running: boolean): void {
  if (ensuring === running) return;
  ensuring = running;
  events.emit(extensionsInventoryChangedChannel, { extensionId: ASSISTANT_RULES_PROVIDER_ID });
}

export const assistantAppEnsuring = (): boolean => ensuring;
