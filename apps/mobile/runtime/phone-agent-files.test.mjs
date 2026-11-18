import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { openPhoneAgentStore } from './phone-agent-store.mjs'
import { createPhoneFileDownloads, receivePhoneArtifact, phoneFileTools, phoneTurnFiles, registerArtifact } from './phone-agent-files.mjs'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const agent = { agentUserId: '558fcc98-9d61-4054-8a18-900d969b1849', sessionId: '13226587-813a-4e58-a023-dc419aeab890' }
const chatId = 'a540c592-971b-4bcf-89c3-944484a14640'
const proof = { permissions: ['READ_MEDIA_IMAGES'], mediaRefs: [{ kind: 'image', id: '10', version: 'v1' }] }
const bytes = Buffer.from('phone media bytes must not become model text')
const chunk = { phone_file_chunk: { offset: 0, total_size: bytes.length, version: 'v1', name: 'image.jpg', mime_type: 'image/jpeg', data_base64: bytes.toString('base64'), eof: true } }
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
const backend = 'https://files.invalid'
const other = { agentUserId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' }
const itemId = 'f8928aa1-88d0-4709-a62b-111c8f93090a'
const revision = { status: 'ready', source: 'managed-object', item_id: itemId, version: 1, file_name: 'brief.txt', content_type: 'text/plain',
  size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const objectUrl = 'https://objects.invalid/file'
const link = { file: `gugu-file://${itemId}?v=1` }
const turnRef = { itemId, version: 1, name: revision.file_name, mimeType: revision.content_type, sizeBytes: bytes.length }

function readFixture(store) {
  const history = []
  const cloud = {
    root: backend,
    attachmentEndpoint: async () => ({ supabaseUrl: cloud.root, anonKey: 'public', token: 'test',
      fetch: async (url, options) => {
        const route = String(url) === objectUrl ? 'bytes' : new URL(url).pathname.split('/').at(-1)
        const body = options?.body ? JSON.parse(options.body) : null
        history.push({ route, body })
        if (route === 'file-resolve') {
          const current = cloud.resolve?.(body) ?? revision
          return current instanceof Response ? current : json(current)
        }
        if (route === 'file-download') {
          cloud.onSign?.()
          return json({ ...revision, url: objectUrl, download_id: 'file' })
        }
        if (route === 'bytes') return cloud.object ? cloud.object(options.signal) : new Response(bytes)
        throw new Error(`Unexpected file request: ${route}`)
      } }),
  }
  const tool = (download, reader) => phoneFileTools({ agent: reader, job: {}, cloud, store, env: {}, download })
    .find(item => item.name === 'message_download_file')
  return { cloud, history, tool, byteRequests: () => history.filter(({ route }) => route === 'bytes').length }
}

test('turn prefetch hands out the canonical private artifact only after fresh authorization and confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-turn-'))
  try {
    await mkdir(join(root, 'actual'))
    await symlink(join(root, 'actual'), join(root, 'alias'))
    const store = { directory: join(root, 'alias'), state: { ownerId, artifacts: {}, agents: { [agent.agentUserId]: agent, [other.agentUserId]: other } }, save: async () => {} }
    const fx = readFixture(store)
    const download = createPhoneFileDownloads({ store, cloud: fx.cloud })
    const turn = phoneTurnFiles({ download, warn: () => {} })
    assert.deepEqual(await turn.prefetch(agent, [turnRef]), [{ itemId, ok: true }])
    const artifact = Object.values(store.state.artifacts)[0]
    assert.equal(artifact.file_path, await realpath(artifact.file_path))
    assert.equal(artifact.file_path.includes('/alias/'), false)
    const beforeTurn = fx.history.length
    assert.equal((await turn(agent, [turnRef])).text.includes(artifact.file_path), true)
    assert.deepEqual(fx.history.slice(beforeTurn).map(({ route }) => route), ['file-resolve', 'file-download', 'file-resolve'])
    assert.equal(fx.byteRequests(), 1)
    assert.deepEqual(await readFile(artifact.file_path), bytes)
    fx.cloud.resolve = () => ({ status: 'gone', sha256: null })
    assert.equal((await turn(agent, [turnRef])).text.includes(artifact.file_path), false)
    assert.equal(fx.byteRequests(), 1)
    delete fx.cloud.resolve
    await writeFile(artifact.file_path, 'edited by agent A')
    const next = await turn(other, [turnRef])
    assert.equal((await readFile(artifact.file_path)).toString(), 'edited by agent A')
    const otherArtifact = Object.values(store.state.artifacts).find(row => row.sessionId === other.sessionId)
    assert.notEqual(otherArtifact.file_path, artifact.file_path)
    assert.ok(next.text.includes(otherArtifact.file_path))
    await rm(otherArtifact.file_path)
    const beforeRetry = fx.byteRequests()
    assert.ok((await turn(other, [turnRef])).text.includes(otherArtifact.file_path))
    assert.equal(fx.byteRequests(), beforeRetry + 1)
    assert.deepEqual(await readFile(otherArtifact.file_path), bytes)
  } finally {
    console.log('Removing own phone turn fixture:', root)
    assert.equal(root.startsWith(join(tmpdir(), 'gugu-phone-turn-')), true)
    await rm(root, { recursive: true, force: true })
  }
})

test('one phone host shares object bytes across references, rechecks readers, and keeps each task path private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-shared-read-'))
  try {
    const store = await openPhoneAgentStore(root, ownerId)
    Object.assign(store.state.agents, { [agent.agentUserId]: agent, [other.agentUserId]: other })
    const fx = readFixture(store)
    const download = createPhoneFileDownloads({ store, cloud: fx.cloud })
    const controller = new AbortController()
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    fx.cloud.object = async (signal) => {
      started.resolve()
      await release.promise
      assert.equal(signal.aborted, false)
      return new Response(bytes)
    }
    const attachment = { source_attachment_id: '9658f49d-e9f5-4efc-a526-ee27e8f517a9' }
    const cancelled = fx.tool(download, agent).execute('cancelled', attachment, controller.signal)
    const didCancel = assert.rejects(cancelled, { code: 'cancelled' })
    await started.promise
    const allSigned = Promise.withResolvers()
    fx.cloud.onSign = () => {
      if (fx.history.filter(({ route }) => route === 'file-download').length === 3) allSigned.resolve()
    }
    const first = fx.tool(download, agent).execute('one', link)
    const second = fx.tool(download, other).execute('two', link)
    await allSigned.promise
    await setImmediate()
    controller.abort()
    await didCancel
    release.resolve()
    const copies = (await Promise.all([first, second])).map(({ details }) => details)
    assert.equal(fx.byteRequests(), 1)
    assert.notEqual(copies[0].file_path, copies[1].file_path)
    for (const [index, reader] of [agent, other].entries()) {
      assert.equal(copies[index].route, 'oss')
      assert.equal(copies[index].sha256, revision.sha256)
      assert.equal(copies[index].size, bytes.length)
      assert.ok(copies[index].file_path.includes(`/downloads/${reader.sessionId}/`))
      assert.deepEqual(await readFile(copies[index].file_path), bytes)
      assert.equal(store.state.artifacts[copies[index].artifact_id].agentUserId, reader.agentUserId)
    }
    const authorized = fx.history.filter(({ route }) => route === 'file-resolve').map(({ body }) => body)
    assert.equal(authorized.filter(({ as, ref }) => as === agent.agentUserId && ref.attachment_id === attachment.source_attachment_id).length, 1)
    for (const reader of [agent, other]) assert.equal(authorized.filter(({ as, ref }) => as === reader.agentUserId && ref.item_id === itemId).length, 2)

    const reopened = await openPhoneAgentStore(root, ownerId)
    const nextDownload = createPhoneFileDownloads({ store: reopened, cloud: fx.cloud })
    const beforeRetry = fx.history.length
    const { details: again } = await fx.tool(nextDownload, agent).execute('again', attachment)
    assert.equal(again.file_path, copies[0].file_path)
    assert.equal(again.artifact_id, copies[0].artifact_id)
    assert.equal(again.route, 'local')
    assert.equal(again.reused, 'verified-local')
    assert.deepEqual(fx.history.slice(beforeRetry).map(({ route }) => route), ['file-resolve', 'file-download', 'file-resolve'])
    assert.ok(fx.history.slice(beforeRetry).every(({ body }) => body.as === agent.agentUserId && body.ref.attachment_id === attachment.source_attachment_id))
    assert.equal(fx.byteRequests(), 1)

    let checks = 0
    fx.cloud.resolve = () => ++checks === 2 ? new Response('Forbidden', { status: 403 }) : revision
    await assert.rejects(fx.tool(nextDownload, agent).execute('revoked', link), { code: 'access_revoked' })
    assert.equal(fx.byteRequests(), 1)
    delete fx.cloud.resolve

    const existing = reopened.state.artifacts[again.artifact_id]
    delete existing.downloadBackend
    await reopened.save()
    const { details: upgraded } = await fx.tool(nextDownload, agent).execute('old-artifact', link)
    assert.equal(upgraded.file_path, again.file_path)
    assert.equal(fx.byteRequests(), 2)
    const { details: reused } = await fx.tool(nextDownload, agent).execute('upgraded', link)
    assert.equal(reused.reused, 'verified-local')
    assert.equal(fx.byteRequests(), 2)
    await writeFile(again.file_path, Buffer.alloc(bytes.length))
    const { details: repaired } = await fx.tool(nextDownload, agent).execute('repair', link)
    assert.equal(repaired.file_path, again.file_path)
    assert.equal(fx.byteRequests(), 3)
    assert.deepEqual(await readFile(repaired.file_path), bytes)

    fx.cloud.root = 'https://other-backend.invalid'
    const migrated = createPhoneFileDownloads({ store: reopened, cloud: fx.cloud })
    const { details: otherBackend } = await fx.tool(migrated, agent).execute('other-backend', link)
    assert.equal(otherBackend.file_path, again.file_path)
    assert.equal(otherBackend.route, 'oss')
    assert.equal(fx.byteRequests(), 4)
  } finally {
    console.log('Removing own phone download fixture:', root)
    assert.ok(root.startsWith(join(tmpdir(), 'gugu-phone-shared-read-')))
    await rm(root, { recursive: true, force: true })
  }
})

test('a turn prefetch and the Pi tool share the host transfer, and the last cancelled reader stops it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-last-reader-'))
  try {
    const store = await openPhoneAgentStore(root, ownerId)
    store.state.agents[agent.agentUserId] = agent
    const fx = readFixture(store)
    const download = createPhoneFileDownloads({ store, cloud: fx.cloud })
    const turn = phoneTurnFiles({ download })
    const controller = new AbortController()
    const started = Promise.withResolvers(), stopped = Promise.withResolvers(), bothSigned = Promise.withResolvers()
    fx.cloud.object = (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { stopped.resolve(); reject(signal.reason) }, { once: true })
      started.resolve()
    })
    const prefetch = turn.prefetch(agent, [turnRef], controller.signal)
    await started.promise
    fx.cloud.onSign = () => bothSigned.resolve()
    const die = fx.tool(download, agent).execute('cancelled', link, controller.signal)
    const cancelled = assert.rejects(die, { code: 'cancelled' })
    await bothSigned.promise
    await setImmediate()
    assert.equal(fx.byteRequests(), 1)
    controller.abort()
    await Promise.all([prefetch, cancelled, stopped.promise])
    const [failed] = await prefetch
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'cancelled')
    assert.deepEqual(store.state.artifacts, {})
    delete fx.cloud.object
    const { details } = await fx.tool(download, agent).execute('retry', link)
    assert.equal(fx.byteRequests(), 2)
    assert.equal(details.sha256, revision.sha256)
    assert.deepEqual(await readFile(details.file_path), bytes)
  } finally {
    console.log('Removing own phone cancellation fixture:', root)
    assert.ok(root.startsWith(join(tmpdir(), 'gugu-phone-last-reader-')))
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-file-'))
  const store = await openPhoneAgentStore(root, ownerId)
  const job = { id: 'd6857196-44c1-49c0-b265-e18de6ea3f51', usedGroups: ['photos'], permissionRequirements: [proof] }
  const artifact = await receivePhoneArtifact({ first: { ...chunk, pictures: [{ mimeType: 'image/jpeg', data: 'private-thumbnail-bytes' }] }, args: { id: '10' }, read: async () => { throw new Error('one chunk is complete') }, agent, job, signal: new AbortController().signal, store, root, group: 'photos' })
  const requests = []
  const cloud = {
    rpc: async (_schema, name) => name === 'list_member_ids' ? [{ user_id: agent.agentUserId }, { user_id: ownerId }] : [{ kind: 'dm', group_prompt: null }],
    attachmentEndpoint: async () => ({ supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'private-token', fetch: async (url, options) => {
      requests.push([String(url), options])
      if (String(url).endsWith('/attachments/upload')) return json({ staging_key: 'staged', url: 'https://storage.invalid/put', fields: {}, max_bytes: 1024 })
      if (String(url).includes('/put')) return new Response('', { status: 200 })
      if (String(url).endsWith('/attachments/commit')) return json({ message: { id: JSON.parse(options.body).message_id } })
      if (String(url).endsWith('/attachments/finish')) return json({ status: 'ready' })
      throw new Error('unexpected endpoint')
    } }),
  }
  return { root, store, job, artifact, cloud, requests, async close() { await rm(root, { recursive: true }) } }
}

test('native chunks become an owner-scoped complete artifact and private permission proof never reaches Pi text', async () => {
  const fx = await fixture()
  try {
    assert.equal(JSON.stringify(fx.artifact).includes(bytes.toString('base64')), false)
    assert.equal(JSON.stringify(fx.artifact.data).includes('READ_MEDIA_IMAGES'), false)
    assert.deepEqual(fx.artifact.content.map((block) => block.type), ['text'])
    assert.equal(JSON.stringify(fx.artifact).includes('private-thumbnail-bytes'), false)
    const stored = fx.store.state.artifacts[fx.artifact.data.artifact_id]
    assert.deepEqual(stored.permissionRequirements, [proof])
    assert.deepEqual(stored.groups, ['photos'])
    assert.equal(stored.agentUserId, agent.agentUserId)
  } finally { await fx.close() }
})

test('file sending declares the file in its commit (agent sender, stable message id), then uploads the real bytes and finishes them', async () => {
  const fx = await fixture()
  const checked = []
  try {
    const tool = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: { GUGU_HOME: fx.root }, authorize: async (groups, artifact) => { checked.push([groups, artifact.permissionRequirements]) }, emit: () => undefined }).find((item) => item.name === 'message_send_file')
    const args = { chat_id: chatId, file_path: fx.artifact.data.file_path, to_user_ids: [`user:${ownerId}`] }
    const sent = await tool.execute('first', args)
    await tool.execute('retry', args)
    assert.equal(fx.requests.filter(([url]) => url.endsWith('/commit')).length, 1)
    const permit = JSON.parse(fx.requests.find(([url]) => url.endsWith('/upload'))[1].body)
    assert.deepEqual({ size_bytes: permit.size_bytes, as: permit.as, chat_id: permit.chat_id }, { size_bytes: bytes.length, as: agent.agentUserId, chat_id: chatId })
    assert.match(permit.request_id, /^[0-9a-f-]{36}$/i)
    const upload = fx.requests.find(([url]) => url.includes('/put'))[1].body.get('file')
    assert.deepEqual(Buffer.from(await upload.arrayBuffer()), bytes)
    const commit = JSON.parse(fx.requests.find(([url]) => url.endsWith('/commit'))[1].body)
    assert.equal(commit.sender_user_id, agent.agentUserId)
    // One path for every sender (owner 11-15): the message goes with the file's index, its bytes follow it.
    assert.deepEqual({ sha256: commit.sha256, size_bytes: commit.size_bytes }, { sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length })
    const order = fx.requests.map(([url]) => url.endsWith('/commit') ? 'commit' : url.includes('/put') ? 'bytes' : url.endsWith('/finish') ? 'finish' : null).filter(Boolean)
    assert.deepEqual(order, ['commit', 'bytes', 'finish'])
    assert.equal(JSON.parse(fx.requests.find(([url]) => url.endsWith('/finish'))[1].body).message_id, commit.message_id)
    assert.equal(sent.details.message_id, `msg:${commit.message_id}`)
    assert.equal(checked.length >= 2, true)
    assert.deepEqual(checked[0][1], [proof])
  } finally { await fx.close() }
})

test('unregistered paths, changed bytes and permission revocation before commit cannot send a file', async () => {
  const fx = await fixture()
  try {
    let checks = 0
    const tools = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: { GUGU_HOME: fx.root }, authorize: async () => { if (++checks > 1) throw Object.assign(new Error('photo permission revoked'), { code: 'os_permission' }) }, emit: () => undefined })
    const send = tools.find((item) => item.name === 'message_send_file')
    await assert.rejects(send.execute('unknown', { chat_id: chatId, file_path: '/etc/hosts' }), /登记/)
    await assert.rejects(send.execute('revoked', { chat_id: chatId, file_path: fx.artifact.data.file_path }), /permission revoked/)
    assert.equal(fx.requests.some(([url]) => url.endsWith('/commit')), false)
    await writeFile(fx.artifact.data.file_path, Buffer.alloc(bytes.length, 0))
    await assert.rejects(send.execute('modified', { chat_id: chatId, file_path: fx.artifact.data.file_path }), /内容已变化/)
  } finally { await fx.close() }
})

test('attachment download ignores an untrusted body URL and requires message ACL before requesting any object bytes', async () => {
  const fx = await fixture()
  try {
    let readable = false
    fx.cloud.rpc = async (_schema, name) => { assert.equal(name, 'can_read_message'); return readable }
    fx.cloud.chat = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: '4f6dac4f-a3f2-48da-9876-d3a4567d8b64', content_type: 'attachment', content: '[附件] secret.txt (text/plain)\n[URL] http://127.0.0.1/secret\n[Size] 42\n[Kind] file' }, error: null }) }) }) }) }
    const endpoint = await fx.cloud.attachmentEndpoint()
    fx.cloud.attachmentEndpoint = async () => ({ ...endpoint, fetch: async (url, init) => { fx.requests.push([String(url), init]); return json({ status: 'gone', sha256: null }) } })
    const tool = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, download: createPhoneFileDownloads({ store: fx.store, cloud: fx.cloud }) }).find((item) => item.name === 'message_download_file')
    await assert.rejects(tool.execute('denied', { source_message_id: 'msg:4f6dac4f-a3f2-48da-9876-d3a4567d8b64' }), /不可见/)
    assert.deepEqual(fx.requests, [])
    readable = true
    await assert.rejects(tool.execute('unsafe', { source_message_id: 'msg:4f6dac4f-a3f2-48da-9876-d3a4567d8b64' }), { code: 'gone' })
    assert.deepEqual(fx.requests.map(([url]) => url), ['https://files.invalid/functions/v1/attachments/file-resolve'])
    assert.deepEqual(JSON.parse(fx.requests[0][1].body), { ref: { message_id: '4f6dac4f-a3f2-48da-9876-d3a4567d8b64' }, as: agent.agentUserId })
  } finally { await fx.close() }
})

test('the message authority downloads the verified original even when its body contains a local-network URL', async () => {
  const fx = await fixture()
  const id = '4f6dac4f-a3f2-48da-9876-d3a4567d8b64'
  try {
    fx.cloud.rpc = async (_schema, name) => { assert.equal(name, 'can_read_message'); return true }
    fx.cloud.chat = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id, content_type: 'attachment', content: '[附件] private.bin (application/octet-stream)\n[URL] http://127.0.0.1/secret\n[Size] 42\n[Kind] file' }, error: null }) }) }) }) }
    const endpoint = await fx.cloud.attachmentEndpoint()
    const revision = { status: 'ready', source: 'managed-object', file_name: 'private.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    fx.cloud.attachmentEndpoint = async () => ({ ...endpoint, fetch: async (url, init) => {
      fx.requests.push([String(url), init])
      if (String(url).endsWith('/file-resolve')) { assert.deepEqual(JSON.parse(init.body), { ref: { message_id: id }, as: agent.agentUserId }); return json(revision) }
      if (String(url).endsWith('/file-download')) { assert.equal(JSON.parse(init.body).as, agent.agentUserId); return json({ ...revision, download_id: 'download', url: 'https://storage.invalid/original' }) }
      assert.equal(String(url), 'https://storage.invalid/original'); assert.equal(init?.headers?.Authorization, undefined); return new Response(bytes)
    } })
    const tool = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, download: createPhoneFileDownloads({ store: fx.store, cloud: fx.cloud }) }).find(item => item.name === 'message_download_file')
    const original = (await tool.execute('original', { source_message_id: `msg:${id}` })).details
    assert.deepEqual(await readFile(original.file_path), bytes)
    assert.equal(original.sha256, revision.sha256)
    assert.deepEqual(fx.requests.map(([url]) => url), ['https://files.invalid/functions/v1/attachments/file-resolve', 'https://files.invalid/functions/v1/attachments/file-download', 'https://storage.invalid/original', 'https://files.invalid/functions/v1/attachments/file-resolve'])
    assert.equal(JSON.stringify(original).includes('127.0.0.1'), false)
  } finally { await fx.close() }
})

test('task text reads only its registered intact artifact, with explicit Unicode pagination and permission proof', async () => {
  const fx = await fixture()
  try {
    const text = '手机😀任务附件\n第二行内容'
    const bytes = Buffer.from(text)
    const path = join(fx.root, 'task-upload.txt')
    await writeFile(path, bytes)
    const registered = await registerArtifact({ store: fx.store, agent, groups: ['photos'], file: { file_path: path, name: 'task-upload.txt', mime_type: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), permissionRequirements: [proof] } })
    const checked = []
    const read = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async (groups, file) => { checked.push([groups, file.permissionRequirements]) }, emit: () => undefined }).find((tool) => tool.name === 'phone_file_read')
    const first = (await read.execute('first', { file_path: registered.file_path, limit: 4 })).details
    const next = (await read.execute('next', { file_path: registered.file_path, offset: first.next_offset, limit: 32768 })).details
    assert.equal(first.text, '手机😀任')
    assert.equal(first.eof, false)
    assert.equal(first.text + next.text, text)
    assert.equal(next.eof, true)
    assert.equal(next.total_chars, Array.from(text).length)
    assert.ok(checked.length >= 4)
    assert.deepEqual(checked[0][1], [proof])
    assert.deepEqual(fx.job.permissionRequirements, [proof])
    const list = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async () => undefined, emit: () => undefined }).find((tool) => tool.name === 'phone_file_list')
    const directory = registered.file_path.slice(0, registered.file_path.lastIndexOf('/'))
    const listing = (await list.execute('registered-folder', { folder_path: directory })).details
    assert.ok(listing.files.some((entry) => entry.file_path === registered.file_path))
    assert.equal((await list.execute('unregistered-folder', { folder_path: '/etc' })).details.files.length, 0)
    await assert.rejects(read.execute('arbitrary', { file_path: '/etc/hosts' }), { code: 'not_granted' })
    await assert.rejects(read.execute('binary', { file_path: fx.artifact.data.file_path }), { code: 'unsupported' })
    await writeFile(path, Buffer.alloc(bytes.length, 65))
    await assert.rejects(read.execute('changed', { file_path: registered.file_path }), { code: 'file_changed' })
  } finally { await fx.close() }
})

test('text permission revoked during a file read prevents returning the private page', async () => {
  const fx = await fixture()
  try {
    const path = join(fx.root, 'private.txt')
    const bytes = Buffer.from('private-text-must-not-be-delivered')
    await writeFile(path, bytes)
    const registered = await registerArtifact({ store: fx.store, agent, groups: ['photos'], file: { file_path: path, name: 'private.txt', mime_type: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), permissionRequirements: [proof] } })
    let checks = 0
    const read = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async () => { if (++checks > 1) throw Object.assign(new Error('photo permission revoked during read'), { code: 'os_permission' }) }, emit: () => undefined }).find((tool) => tool.name === 'phone_file_read')
    await assert.rejects(read.execute('revoked', { file_path: registered.file_path }), { code: 'os_permission' })
    assert.equal(checks, 2)
  } finally { await fx.close() }
})
