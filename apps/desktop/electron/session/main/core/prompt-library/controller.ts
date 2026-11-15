import { createRPCController } from '@shared/lib/ipc/rpc';
import { type PromptLibrary, type PromptLibraryPrompt, type PromptOverride } from '@shared/prompt-library';
import { promptLibraryService } from './service';

export const promptLibraryController = createRPCController({
  get: (): Promise<PromptLibrary> => promptLibraryService.getPrompts(),
  save: (prompt: PromptLibraryPrompt): Promise<PromptLibrary> => promptLibraryService.savePrompt(prompt),
  delete: (id: string): Promise<PromptLibrary> => promptLibraryService.deletePrompt(id),
  override: (key: string, override: PromptOverride | null): Promise<PromptLibrary> => promptLibraryService.overridePrompt(key, override),
});
