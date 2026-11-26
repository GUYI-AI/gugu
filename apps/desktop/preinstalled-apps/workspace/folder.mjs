/* global gugu */ // An App program's gugu: the page's, for the page's own verbs (guide apps-programs).
// The Files App's tools for an agent's chat files (moved into the App 2026-10-11): list, edit (rename / move), delete. A
// file's bytes come and go through the host alone: message_download_file saves one here, file_put puts one there — new,
// or a downloaded file's next version — and message_send's file_path sends one.
// Every one acts as the agent that calls it: a chat it hands (`gugu-chat`) or a file it hands (`gugu-file`) is checked as
// that agent at the gateway, and what the tool reads and writes there is the agent's, by its own membership.
// Only the public API: gugu.files, and Node's own modules for the files on this computer.
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownLiteral } from './markdown-literal.js'

const CHAT = {
  type: 'string',
  format: 'gugu-chat',
  description: 'The source group or private chat whose folder it is. A topic address uses its source folder. Use the delivery chat=, <project_group>\'s chat_id, or the number people see.',
}
const ITEM = { type: 'string', format: 'gugu-file', description: 'A file of a chat\'s folder: its id, as list or a gugu-file:// link gives it.' }
/** At most this many files in one call (item_ids): its answer and its time stay bounded; more go in batches. */
const MANY = 200
const ITEMS = { type: 'array', items: ITEM, maxItems: MANY, description: `Several files instead of item_id, at most ${MANY} a call, one after another: the first refusal stops the rest.` }
/** item_id or item_ids, one of them: the ids to work on. */
function idsOf(item_id, item_ids) {
  if ((item_id === undefined) === (item_ids === undefined)) throw new Error('give item_id (one file) or item_ids (several), one of them')
  if (item_ids === undefined) return [item_id]
  if (!Array.isArray(item_ids) || item_ids.length === 0) throw new Error('item_ids is a list of file ids, at least one')
  if (item_ids.length > MANY) throw new Error(`item_ids takes at most ${MANY} files a call; give the rest in another call`)
  return item_ids
}
/** One file after another until one is refused: how many went, and where it stopped (the ones after it were not tried). */
async function oneByOne(ids, work) {
  for (const [done, id] of ids.entries()) {
    try {
      await work(id)
    } catch (error) {
      return { done, stopped_at: { id, error: error.message } }
    }
  }
  return { done: ids.length }
}
/** 子文件夹: a folder of a chat's folder, as the tools take it — by its path from the top, or its id. */
const FOLDER = {
  type: 'string',
  description: 'A folder in the chat\'s folder: its path from the top, such as 合同/2026 (made when it is not there), or its id. Left out: the top.',
}

/**
 * chat_id as gugu.files takes it, for every tool that takes one: text, as the gateway hands it — the number people see sent
 * as a JSON number is made text there, where the chat is checked as the agent (extension-gateway handedText), never here.
 * Anything else is refused before the folder is asked, saying what chat_id takes (A/B 10-12: the runtime's "Say where:
 * { chat: id } …" said nothing about chat_id).
 */
function chatOf(chatId) {
  if (typeof chatId === 'string' && chatId) return chatId
  throw new Error(`chat_id is a chat's id or the number people see (its 咕咕号), not ${typeof chatId === 'number' ? chatId : JSON.stringify(chatId)}`)
}

/** The file as a link, handed over whole: in a message it shows as that file and opens it (never assembled by the agent). */
const linkOf = async (entry) => `[${markdownLiteral(entry.name)}](${await gugu.linkTo({ kind: 'file', file: entry.id })})`
/** A file's link — a folder has none: it is listed and entered, never opened (子文件夹). */
const linked = async (entry) => (entry.type === 'folder' ? {} : { link: await linkOf(entry) })
const byOf = (entry) => (entry.createdBy?.id ? { id: entry.createdBy.id, name: entry.createdBy.name, kind: entry.createdBy.kind } : null)
const rowOf = async (entry) => ({
  id: entry.id,
  name: entry.name,
  path: entry.path,
  type: entry.type,
  size: entry.size,
  ...(Number.isInteger(entry.version) ? { version: entry.version } : {}),
  by: byOf(entry),
  updated_at: entry.updatedAt,
  metadata: entry.metadata ?? {},
  ...await linked(entry),
})

/** `rows`, as every listing tool takes it: "20" is the first 20, "21-40" rows 21 to 40; default the first 20. */
function windowOf(rows) {
  const spec = String(rows ?? '20').trim()
  const range = /^(\d+)(?:-(\d+))?$/.exec(spec)
  if (!range) throw new Error(`rows takes "20" or "21-40", not ${JSON.stringify(spec)}`)
  const from = range[2] === undefined ? 1 : Number(range[1])
  const to = range[2] === undefined ? Number(range[1]) : Number(range[2])
  if (from < 1 || to < from) throw new Error(`rows ${spec} is no window: count from 1, the end not before the start`)
  return { from, to }
}

/** What the folder said, in the words an agent acts on; anything else as it was said. */
function said(error, itemId) {
  if (error?.code === 'not-found') return new Error(`no file ${itemId} in a chat you are in: list shows what is there`)
  const reason = error?.detail?.reason
  // 子文件夹: a folder is listed, never read or changed as a file.
  if (error?.code === 'invalid' && reason === 'folder') return new Error(`${itemId} is a folder: list it (folder: its path or id) to see what is in it`)
  return error
}

/** list's saved rows on this computer: one folder per agent, never one every caller shares. */
function agentFolder(agent, what) {
  const who = String(agent ?? '').replace(/^user:/, '')
  if (!/^[A-Za-z0-9-]+$/.test(who)) throw new Error(`${what}: only an agent saves into a folder of its own on this computer, and this call names no agent`)
  return join(tmpdir(), 'gugu-workspace', who)
}
export const list = {
  description:
    'Chat files (聊天文件 in the Files App), shared by a source group or private chat, newest first: id, name, path (from the top: 合同/2026/甲方.pdf), type (folder for a subfolder), size, version, who made it, link (its gugu-file:// target is what message_download_file saves on this computer and message_send\'s file sends); the header counts its text files, stored files and folders. folder lists only what is directly in that folder.',
  inputSchema: {
    type: 'object',
    required: ['chat_id'],
    properties: {
      chat_id: CHAT,
      folder: { ...FOLDER, description: 'Only what is directly in this folder: its path from the top (合同/2026) or its id; "" the top. Left out: everything, every folder included.' },
      name: { type: 'string', description: 'Only files whose name contains this.' },
      kind: {
        type: 'string',
        enum: ['document', 'file', 'folder'],
        description: 'document = a text or JSON file; file = stored bytes (an image, a PDF, a .pptx…); folder = a subfolder.',
      },
      rows: { type: 'string', description: 'Which rows: "20" the first 20 (default), "21-40" the next.' },
      save: { type: 'boolean', description: 'Save every row that matches (no rows window) as JSON on this computer and answer with its path and count: pick ids there (by, updated_at, path) for item_ids.' },
    },
  },
  annotations: { readOnlyHint: true },
  async run({ chat_id: given, folder, name, kind, rows, save }, { agent } = {}) {
    const chat_id = chatOf(given)
    const window = windowOf(rows)
    if (folder !== undefined && typeof folder !== 'string') throw new Error('folder is a folder\'s path from the top (合同/2026) or its id; "" the top')
    const all = await gugu.files.list(folder === undefined ? { chat: chat_id } : { chat: chat_id, folder })
    const kindOf = (entry) => (entry.type === 'folder' ? 'folder' : entry.type === 'binary' ? 'file' : 'document')
    const wanted = all.filter(
      (entry) =>
        (!name || entry.name.toLowerCase().includes(String(name).toLowerCase())) &&
        (!kind || kind === kindOf(entry)),
    )
    if (save === true) {
      const dir = join(agentFolder(agent, 'list'), chat_id)
      await mkdir(dir, { recursive: true })
      const path = join(dir, 'list.json')
      await writeFile(path, JSON.stringify(await Promise.all(wanted.map(rowOf))))
      return { chat_id, total: wanted.length, saved_to: path }
    }
    const shown = wanted.slice(window.from - 1, window.to)
    const size = window.to - window.from + 1
    return {
      chat_id,
      ...(folder === undefined ? {} : { folder }),
      documents: all.filter((entry) => kindOf(entry) === 'document').length,
      files: all.filter((entry) => kindOf(entry) === 'file').length,
      folders: all.filter((entry) => kindOf(entry) === 'folder').length,
      total: wanted.length,
      rows: shown.length ? `${window.from}-${window.from + shown.length - 1}` : null,
      next: window.to < wanted.length ? `${window.to + 1}-${window.to + size}` : null,
      items: await Promise.all(shown.map(rowOf)),
    }
  },
}

export const edit = {
  description:
    'Rename or move a file of a chat\'s folder: name renames it — a name with / moves it (合同/2026/甲方.pdf; /甲方.pdf to the top), a folder too, with all in it; a name ending in / (合同/2026/) moves it there keeping its name. item_ids with such a name moves several, stopping at the first refusal: moved counts them, stopped_at says which and why. Its content changes through file_put: download it (message_download_file), change your copy, put it back with its file link.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: ITEM,
      item_ids: ITEMS,
      name: {
        type: 'string',
        description: 'The file\'s new name: only its name changes. With /, its new place too: 合同/2026/甲方.pdf moves it into that folder (made when it is not there), /甲方.pdf to the top; ending in / (合同/2026/, / the top) keeps its name.',
      },
    },
  },
  async run({ item_id, item_ids, name, ...rest }) {
    if (['old', 'new', 'path', 'expected_version'].some((key) => key in rest)) {
      throw new Error('edit renames and moves only. To change what is in a file: message_download_file, change your copy, then file_put it back with its gugu-file://<id>?v=<n> link')
    }
    const ids = idsOf(item_id, item_ids)
    if (item_ids !== undefined && (typeof name !== 'string' || !name.trim().endsWith('/'))) {
      throw new Error('item_ids goes with a name ending in / alone: the folder they all move into (合同/2026/, / the top)')
    }
    if (typeof name !== 'string' || !name.trim()) throw new Error('name must not be empty')
    const wanted = name.trim()
    const taken = (error, id) => {
      if (error?.code === 'name-taken') return new Error(`${wanted}: that folder already has a file of that name (case not counted) — pick another name`)
      return said(error, id)
    }
    // 子文件夹: a name with / says where it goes as well (a leading / is the top); ending in /, only where.
    const slash = wanted.lastIndexOf('/')
    const base = wanted.slice(slash + 1).trim()
    const moveTo = (id) => gugu.files.move({ id }, { folder: wanted.slice(0, slash), ...(base ? { name: base } : {}) }).catch((error) => {
      throw taken(error, id)
    })
    if (item_ids !== undefined) {
      const { done, ...stopped } = await oneByOne(ids, moveTo)
      return { moved: done, ...stopped }
    }
    if (slash >= 0) {
      const moved = await moveTo(item_id)
      return { moved: { id: moved.id, name: moved.name, path: moved.path }, ...await linked(moved) }
    }
    const renamed = await gugu.files.rename({ id: item_id }, wanted).catch((error) => {
      throw taken(error, item_id)
    })
    return { renamed: { id: renamed.id, name: renamed.name, path: renamed.path }, ...await linked(renamed) }
  },
}

const remove = {
  description:
    'Delete a file from a chat\'s folder, with its kept versions — or a subfolder with everything in it. Only whoever made them (you, or your owner) can; a folder holding something you cannot delete is left as it is. item_ids deletes several: if any of them may not be deleted, none is, and the answer names those.',
  inputSchema: { type: 'object', properties: { item_id: ITEM, item_ids: ITEMS } },
  async run({ item_id, item_ids }) {
    const ids = idsOf(item_id, item_ids)
    const gone = (id) => gugu.files.remove({ id }).catch((error) => {
      throw said(error, id)
    })
    if (item_ids === undefined) {
      await gone(item_id)
      return { deleted: item_id }
    }
    // Asked for all of them at once first (the database's rule, the one its delete keeps): one refused, none deleted.
    const may = await gugu.files.canDelete(ids.map((id) => ({ id })))
    const refused = ids.filter((_, at) => !may[at])
    if (refused.length) throw new Error(`nothing was deleted: you may not delete ${refused.join(', ')} (not in a chat you are in, or made by someone else; a folder, by what is in it)`)
    const { done, ...stopped } = await oneByOne(ids, gone)
    return { deleted: done, ...stopped }
  },
}
export { remove as delete }
