import { FILE_LINK_IN_TEXT, parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { chatDb } from './supabase'

/** Everyone who made the chat files a message cites: each file's creator, last editor and the authors of its kept versions. */
export async function citedFileEditorIds(text: string, actorId: string): Promise<string[]> {
  const itemIds = new Set([...text.matchAll(FILE_LINK_IN_TEXT)].flatMap(([href]) => parseGroupFileLink(href)?.itemId ?? []))
  const editors = await Promise.all([...itemIds].map(async (itemId) => {
    const [item, versions] = await Promise.all([
      chatDb.rpc('workspace_get_as', { p_item_id: itemId, p_as_user_id: actorId }).select('created_by,updated_by').single<{ created_by: string | null; updated_by: string | null }>(),
      chatDb.rpc('workspace_versions_as', { p_item_id: itemId, p_as_user_id: actorId }),
    ])
    if (item.error) throw item.error
    if (versions.error) throw versions.error
    return [item.data.created_by, item.data.updated_by, ...(versions.data ?? []).map((version: { made_by: string | null }) => version.made_by)]
  }))
  return [...new Set(editors.flat().filter((id): id is string => !!id))]
}
