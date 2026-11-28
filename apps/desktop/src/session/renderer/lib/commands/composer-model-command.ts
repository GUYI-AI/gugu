import { screenLayout } from '@renderer/app/screen-layout';
import { commandRegistry } from './registry';

/** Only the visible control in the current split pane offers its command. */
export function isCurrentComposerControl(control: HTMLElement, context: HTMLElement | null): boolean {
  if (!control.checkVisibility()) return false;
  const block = control.closest<HTMLElement>('[data-screen-block]');
  if (!block) return true;
  const origin = context?.closest<HTMLElement>('[data-screen-block]');
  return block.dataset.screenBlock === (origin?.checkVisibility() ? origin.dataset.screenBlock : screenLayout.focusedBlockId);
}

export function registerComposerModelCommand(trigger: HTMLButtonElement, open: () => void): () => void {
  return commandRegistry.register({
    scopeId: 'session-sub',
    isActive: context => isCurrentComposerControl(trigger, context),
    getCommands: () => [{ id: 'session.switchModel', execute: open }],
  });
}
