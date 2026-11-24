# Personal conversation list visibility: shared client contract

Refs #1924. Backend wire protocol: [gugu-supabase#201](https://github.com/GUYI-AI/gugu-supabase/pull/201).

Desktop and phone use the same list and store for personal visibility.

## Projection and merge

`ChatItem` carries the signed-in member's `conversation_hidden_at` and `conversation_visibility_revision`, plus its source seat's `source_conversation_hidden_at` and `source_conversation_visibility_revision` for a topic. These are personal projection fields; other members' hidden state must never enter membership views or broadcasts.

Import `mergeConversationVisibility`, `isConversationHidden`, `visibleConversationRows`, `isChatListed`, and `chatAttention` from `@gugu/core/shared/ui/chatModels`.

- Merge fetched rows with `mergeConversationVisibility(fetched, local)` before publishing or persisting them. Revisions are canonical unsigned decimal **strings**; the helper compares them exactly with `BigInt`, including values above 2^53. Own and source seats merge independently. An older hide cannot overwrite a newer restoration, and an older snapshot cannot undo a confirmed hide.
- Keep the complete directory for addressing, search, existing tabs, drafts, file links and receipts. Do not delete hidden rows from that directory. Opening/searching a hidden row does not restore it.
- Use `visibleConversationRows(fullDirectory)` for list and aggregate badge scope. A hidden source excludes its descendant topics without changing their individual hidden state or read cursors. A missing source or peer is not proof of a hide (#1892); missing projection data remains a separate diagnostic condition.
- Use `isChatListed` after scope filtering for the existing empty-DM rule. `chatAttention` preserves raw unread but returns zero list/global attention for an explicitly hidden row. Topic addressed-count and mute rules remain unchanged.
- `phoneChatUnread` now sums only visible scope. A visible source does not receive a hidden topic's badge. Restoration counts retained read positions, with each stream counted once by the existing unread projection.

## Long-press/right-click menu

`ChatRowContextMenu` draws the right-click and long-press menus from `personalConversationMenu`. Pass `onHide={() => hideConversation(chat.id)}` from the chat store. The action resolves to its validated receipt, or `undefined` if the account session ends. The receipt enables the shared Undo notice.

`store/useConversationHiding.ts` owns the action through `lib/conversationHider.ts`. `lib/hideListedConversation.ts` validates the RPC's echoed chat and operation IDs, timestamp, and exact decimal revision. For an already projected row, `lib/chatProjection.ts` applies the committed visibility to that row at the returned revision and republishes the full directory. The account journal continues to reconcile membership and unread state. A newer restoration supersedes an older receipt.

Concurrent submissions share one in-flight operation. A transport failure retains the operation UUID for an explicit retry. An acknowledged receipt is retained if local publication fails. On the next click, a newer visible revision supersedes that saved receipt and starts a fresh Hide. Otherwise the click retries publication with the saved receipt.

Hide preserves membership, history, tabs and drafts. Clear chat history and Agent archival have their own menu actions.

## Release acceptance still required

Use the same backend and both client heads. Hide on one client, verify the other consumes the same hidden revision, publish a new visible message, then verify both restore the row with correct unread. Include owner input, native Agent reply, mentions, system messages, topic/source restoration, mute, offline first delivery, duplicate publication and hide retries. History import/replay must not restore a row. Backend migration review and a scheduled staging deployment are required before claiming these chains pass.
