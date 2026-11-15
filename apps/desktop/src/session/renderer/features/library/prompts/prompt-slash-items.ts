import type { CommandItem } from '@gugu/session-ui/react/components';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { filterSlashCommands } from '@renderer/features/sessions/acp/slash-command-matching';
import { withOverrides, type PromptLibrary, type PromptLibraryPrompt } from '@shared/prompt-library';

/**
 * The prompts of the composer's `/` menu, one list for the chat composer and the session's: the person's own under
 * `mine`, then each enabled App's under its name (`contributes.prompts`). A prompt is plain text: picking it inserts a
 * folded block whose token is the text itself (`slashCommand`, kind `prompt`), so what is sent is exactly that text.
 * An App prompt's other-language titles ride in the description, so `/` finds it by either title; one the person edited
 * shows their text, one they hid is left out.
 */
export function promptSlashItems(mine: readonly PromptLibraryPrompt[], overrides: PromptLibrary['overrides'], mineSection: string, query: string): CommandItem[] {
  const own = mine.map((prompt) => item(`prompt:${prompt.id}`, prompt.title, undefined, prompt.prompt, mineSection));
  const apps = withOverrides(installedExtensionsStore.appPrompts, overrides).filter((prompt) => prompt.state !== 'hidden').map((prompt) =>
    item(`app-prompt:${prompt.key}`, prompt.title, prompt.otherTitles.join(' · ') || undefined, prompt.prompt, prompt.appName));
  return filterSlashCommands([...own, ...apps], query);
}

function item(id: string, title: string, otherTitle: string | undefined, text: string, section: string): CommandItem {
  const preview = text.split(/\r?\n/, 1)[0] ?? '';
  return {
    id,
    name: title,
    label: title,
    description: otherTitle ? `${otherTitle} · ${preview}` : preview,
    behavior: 'insert',
    kind: 'prompt',
    token: text,
    section,
  };
}
