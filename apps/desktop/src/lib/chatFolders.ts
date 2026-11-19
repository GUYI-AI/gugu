// @@@group-folders — the account's folders by group (identity.my_chat_folders): every folder one of my devices binds to a
// group, including devices that are offline now. Only the binding account reads them.
import { listMyChatFolders, type AccountGroupFolders, type ChatFoldersRpcClient } from '@gugu/core/cloud/chatFolders'
import { identityDb } from './supabase'

/** Unreadable = throws (the store keeps showing what it read last and says the read failed). */
export async function listMyGroupFolders(): Promise<AccountGroupFolders[]> {
  // @@@supabase-boundary narrow - identity.my_chat_folders (only the binding account reads its rows).
  return listMyChatFolders(identityDb as unknown as ChatFoldersRpcClient)
}
