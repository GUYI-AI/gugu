import { events } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { promptsChangedChannel } from '@shared/prompt-library';
import { showPromptDeleted } from './use-prompt-library-actions';
import { reloadPrompts } from './use-prompt-library';

/**
 * An App's program changed the person's prompts (`gugu.prompts`, app-prompts.ts): the list re-reads, and a delete is said
 * at once with its undo (owner 11-07「删除只保留撤销条」) — the person never has to go find what an agent removed.
 */
export function wirePromptChanges(): () => void {
  return events.on(promptsChangedChannel, ({ action, prompt, app }) => {
    reloadPrompts();
    if (action === 'delete') showPromptDeleted(prompt, translateSessionMessage('prompts.deletedBy', { app, title: prompt.title }), translateSessionMessage('prompts.undo'));
  });
}
