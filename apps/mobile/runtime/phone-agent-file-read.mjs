import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'

const fail = (code, message) => Object.assign(new Error(message), { code })
const textTypes = /^(?:text\/|application\/(?:json|xml|javascript|x-yaml|yaml|toml)(?:[;+]|$))/i
const textExtension = /\.(?:txt|md|csv|tsv|json|jsonl|log|ya?ml|xml|ics|toml|ini|js|mjs|cjs|ts|tsx|jsx|py|java|kt|css|html?|sql|sh)$/i

/** Folder attachments expose their registered children, never an arbitrary filesystem listing. */
export function phoneArtifactListTool({ agent, job, store, authorize }) {
  return { name: 'phone_file_list', label: 'List task attachments', description: 'List attachments this phone task has uploaded, downloaded or read and registered. For a folder attachment, pass the private directory a tool returned as folder_path to get the file_path of its registered files, then read text with phone_file_read; arbitrary phone directories are never scanned. Page with next_offset.',
    parameters: { type: 'object', properties: { folder_path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
    execute: async (_callId, args) => {
      const offset = args.offset ?? 0
      const limit = args.limit ?? 100
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || args.folder_path !== undefined && (typeof args.folder_path !== 'string' || !args.folder_path)) throw fail('invalid_args', 'Invalid attachment folder or paging arguments')
      const prefix = args.folder_path?.replace(/\/+$/, '')
      const all = Object.values(store.state.artifacts ?? {}).filter((entry) => entry.ownerId === store.state.ownerId && entry.agentUserId === agent.agentUserId && entry.sessionId === agent.sessionId && (!prefix || entry.file_path.startsWith(`${prefix}/`))).sort((a, b) => a.file_path.localeCompare(b.file_path))
      const shown = all.slice(offset, offset + limit)
      const groups = [...new Set([...(job.usedGroups ?? []), ...shown.flatMap((entry) => entry.groups ?? [])])]
      const requirements = [...new Map([...(job.permissionRequirements ?? []), ...shown.flatMap((entry) => entry.permissionRequirements ?? [])].map((proof) => [JSON.stringify(proof), proof])).values()]
      const proof = { sessionId: agent.sessionId, permissionRequirements: requirements }
      await authorize(groups, proof)
      job.usedGroups = groups; job.permissionRequirements = requirements
      await store.save()
      await authorize(groups, proof)
      const data = { files: shown.map((entry) => ({ file_path: entry.file_path, name: entry.name, mime_type: entry.mime_type, size: entry.size, sha256: entry.sha256 })), total: all.length, next_offset: Math.min(all.length, offset + limit), eof: offset + limit >= all.length }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data }
    },
  }
}

/** Bounded UTF-8 pages from an already registered artifact. Full-file hash/size checks and
 * permission checks surround reading; no arbitrary file path or binary parser is exposed. */
export function phoneTextFileTool({ agent, job, store, authorize }) {
  return { name: 'phone_file_read', label: 'Read task text attachment', description: 'Read a UTF-8 text file uploaded in this task, downloaded from a chat attachment, or registered by a phone tool. file_path must be the full registered private path; arbitrary phone files cannot be read. offset is a Unicode character offset, limit is at most 32768 characters per call; continue with next_offset until eof. PDF, Office, images, video and audio are not parsed; such binary files can be sent as they are, but do not claim to have read their content.',
    parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32768 } } },
    execute: async (_callId, args, signal) => {
      const offset = args.offset ?? 0
      const limit = args.limit ?? 8192
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32768) throw fail('invalid_args', 'Invalid text read offset or characters per page')
      const file = Object.values(store.state.artifacts ?? {}).find((entry) => entry.file_path === args.file_path && entry.ownerId === store.state.ownerId && entry.agentUserId === agent.agentUserId && entry.sessionId === agent.sessionId)
      if (!file) throw fail('not_granted', 'Only attachments registered by this phone task can be read; upload the file or download the chat attachment first')
      if (!textTypes.test(file.mime_type ?? '') && !textExtension.test(extname(file.name ?? file.file_path))) throw fail('unsupported', 'This phone tool reads only UTF-8 text and does not parse this binary file')
      const groups = [...new Set([...(job.usedGroups ?? []), ...(file.groups ?? [])])]
      await authorize(groups, file)
      if (await realpath(file.file_path) !== file.file_path) throw fail('file_changed', 'The registered file path changed; not read')
      const before = await stat(file.file_path)
      if (!before.isFile() || before.size !== file.size) throw fail('file_changed', 'The registered file size changed; not read')
      const hash = createHash('sha256')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let total = 0
      let selected = ''
      const take = (text) => {
        if (text.includes('\0')) throw fail('unsupported', 'This file contains binary content, which this phone tool does not parse')
        const characters = Array.from(text)
        const from = Math.max(0, offset - total)
        const until = Math.min(characters.length, offset + limit - total)
        if (until > from) selected += characters.slice(from, until).join('')
        total += characters.length
      }
      try {
        for await (const chunk of createReadStream(file.file_path, { ...(signal ? { signal } : {}) })) { signal?.throwIfAborted(); hash.update(chunk); take(decoder.decode(chunk, { stream: true })) }
        take(decoder.decode())
      } catch (error) { if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw fail('unsupported', 'This file is not UTF-8 text, which this phone tool does not parse'); throw error }
      if (hash.digest('hex') !== file.sha256 || (await stat(file.file_path)).size !== file.size || await realpath(file.file_path) !== file.file_path) throw fail('file_changed', 'The registered file content changed; text not delivered')
      await authorize(groups, file)
      job.usedGroups = groups
      job.permissionRequirements = [...new Map([...(job.permissionRequirements ?? []), ...(file.permissionRequirements ?? [])].map((proof) => [JSON.stringify(proof), proof])).values()]
      await store.save()
      await authorize(groups, file)
      const next = Math.min(total, offset + limit)
      const data = { ok: true, file_path: file.file_path, sha256: file.sha256, text: selected, offset, next_offset: next, total_chars: total, eof: next >= total }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data }
    },
  }
}
