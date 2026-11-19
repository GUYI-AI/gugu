import { listFolders } from './folders';

/** The first folder this device binds to a chat (where what it sends there is kept); undefined = none here. */
export function firstFolderOf(chatId: string): string | undefined {
  return listFolders(chatId)[0]?.id;
}
