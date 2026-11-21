import { randomUUID } from 'node:crypto'
import { PHONE_ACTIONS, phoneActionByName } from '../../desktop/src/mobile/phone-device/phoneActionCatalog.ts'
import { validateToolArguments } from '@earendil-works/pi-ai'
import { withPhoneNativeContext } from './phone-capacitor.mjs'
import { stableId } from './phone-agent-store.mjs'
import { receivePhoneArtifact } from './phone-agent-files.mjs'
import { utcOffsetOf } from '../../desktop/src/mobile/phone-device/phoneTime.ts'

const result = (data, content) => ({ content: content ?? [{ type: 'text', text: JSON.stringify(data) }], details: data })
const failure = (code, message) => Object.assign(new Error(message), { code })
const isFile = (name) => name === 'photos.read' || name === 'recordings.read'
const phoneFileDescriptions = {
  'recordings.read': "Reads the raw audio returned by recordings.list and saves it in chunks to the current phone task's App-private directory; returns the full file_path, mime_type, size and sha256 for sending with message_send_file. Pass the version from the list. Does not turn on the microphone and provides no transcription or understanding of the audio; if access is revoked, the connection drops or the file changes, no partial file is returned.",
  'photos.read': "Reads the raw photo or video returned by photos.list and saves it in chunks to the current phone task's App-private directory; kind matches the list, pass version. Returns the full file path and metadata for sending with message_send_file; this does not mean the model has understood the image or video. Files outside the system-granted scope cannot be read.",
}
const confirmationOptions = [{ optionId: 'approve', name: '允许这一次', kind: 'allow_once' }, { optionId: 'cancel', name: '取消', kind: 'reject_once' }]

export function phoneConfirmationSettlement(pending) {
  const answered = Boolean(pending.respondedAt ?? pending.approvedByMessageId)
  return { itemId: pending.id, kind: 'permission', title: pending.question,
    detail: `${pending.actionName}\n${JSON.stringify(pending.args)}\n确认有效期至 ${pending.expiresAt}`,
    options: confirmationOptions,
    state: answered ? 'resolved' : pending.status === 'pending' ? 'pending' : 'cancelled',
    optionId: answered ? pending.responseOption ?? 'approve' : null,
    resolvedBy: answered ? pending.respondedBy ?? pending.ownerId : null,
    resolvedAt: answered ? Date.parse(pending.respondedAt ?? pending.finishedAt ?? pending.createdAt) : null }
}

export async function createPhoneActionRuntime({ ownerId, store, nativeCall, sendSession, emit, getManifest }) {
  store.state.confirmations ??= {}
  for (const pending of Object.values(store.state.confirmations)) {
    if (!Object.hasOwn(pending, 'contextEpoch')) {
      pending.contextEpoch = 'legacy-unscoped'
      if (['pending', 'approved'].includes(pending.status)) { pending.status = 'cancelled'; pending.error = 'This phone confirmation is from an older version without task context and is no longer valid; start the action again from the task page' }
    }
    // Old DM prompts are historical messages, never an approval transport after upgrade.
    const question = store.state.outbox[pending.messageId]
    if (question?.status === 'pending') question.status = 'superseded'
    if (pending.status === 'executing') { pending.status = 'interrupted'; pending.error = 'The phone stopped during execution; the result is not confirmed and must not be repeated automatically.' }
  }
  await store.save()
  const reconcile = async () => {
    let changed = false
    for (const pending of Object.values(store.state.confirmations)) if (pending.status === 'pending' && Date.parse(pending.expiresAt) <= Date.now()) {
      pending.status = 'expired'; changed = true
      const question = store.state.outbox[pending.messageId]
      if (question?.status === 'pending') question.status = 'expired'
    }
    for (const agent of Object.values(store.state.agents)) if (agent.status === 'needs_user' && !Object.values(store.state.confirmations).some((pending) => pending.agentUserId === agent.agentUserId && pending.status === 'pending')) { agent.status = 'idle'; changed = true }
    if (changed) await store.save()
    return changed
  }
  await reconcile()

  const check = async (agent, groups, signal, requirements = []) => {
    if (!groups.length && !requirements.length) return
    const permit = await nativeCall('permissions.check', { groups: [...new Set(groups)], requirements }, signal, { ownerId, sessionId: agent.sessionId })
    if (!permit?.ok) throw failure(permit?.code ?? 'not_granted', permit?.message ?? 'Phone capability permission has changed')
  }
  const preflight = async (agent, groups, signal) => {
    const permit = await nativeCall('permissions.preflight', { groups: [...new Set(groups)] }, signal, { ownerId, sessionId: agent.sessionId })
    if (!permit?.ok) throw failure(permit?.code ?? 'not_granted', permit?.message ?? 'Phone capability permission has changed')
  }
  const input = (name, raw) => {
    const action = phoneActionByName(name)
    if (!action) throw failure('unknown_action', `This phone has no ${name} action`)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('invalid_args', 'args must be a parameter object')
    if (['confirmed', 'approval', 'internalApproval', '_phone_file_transport', 'offset'].some((field) => field in raw)) throw failure('invalid_args', 'Confirmation and file transfer are handled by the host; the model cannot fill them in')
    let args
    try { args = validateToolArguments({ name, parameters: action.input_schema }, { name, arguments: raw }) }
    catch (error) { throw failure('invalid_args', error.message) }
    return { action, args }
  }

  const execute = async ({ agent, job, action, args, signal, origin = 'phone-agent', approval, callId }) => {
    await preflight(agent, [action.group], signal)
    const requirements = []
    let nativeUnconfirmed = false
    const context = { nativeCall, signal, ownerId, sessionId: agent.sessionId, actionName: action.name, origin, ...(approval ? { approval } : {}),
      // The shared catalog normalizes native errors for the device-action contract. Keep
      // lost-result provenance locally before that mapping erases timeout/disconnect codes.
      recordNativeFailure: (error) => { if (['execution_unknown', 'timeout'].includes(error.code)) nativeUnconfirmed = true },
      recordPermissionRequirements: async (proof) => {
        requirements.push(proof)
        if (job) { job.permissionRequirements ??= []; if (!job.permissionRequirements.some((saved) => JSON.stringify(saved) === JSON.stringify(proof))) job.permissionRequirements.push(proof); await store.save() }
      } }
    const invoke = (next) => withPhoneNativeContext(context, () => action.run(next))
    const prepared = isFile(action.name) ? { ...args, _phone_file_transport: 1 } : args
    let data
    try { data = await invoke(prepared) }
    catch (error) { if (nativeUnconfirmed) throw failure('execution_unknown', 'The native phone call result is not confirmed'); throw error }
    let content
    if (isFile(action.name) && origin === 'phone-agent') {
      const file = await receivePhoneArtifact({ first: data, args: prepared, read: invoke, agent, job, signal, store, root: process.env.GUGU_AGENT_HOME, group: action.group })
      data = file.data; content = file.content
    }
    await check(agent, [action.group], signal, requirements)
    if (job) { job.usedGroups = [...new Set([...(job.usedGroups ?? []), action.group])]; await store.save() }
    emit({ type: 'phone_action', ownerId, sessionId: agent.sessionId, action: action.name, callId, ok: true })
    return { data, content }
  }

  const askOwner = async (agent, job, action, args, callId, signal) => {
    await preflight(agent, [action.group], signal)
    await check(agent, job.usedGroups ?? [], signal, job.permissionRequirements ?? [])
    const described = action.confirmQuestion ? action.confirmQuestion(args) : { question: `要让手机「${action.title}」吗？` }
    // Run the shared normalization/validation with a transport that cannot touch Android.
    // Confirmation is offered only after all parameters are valid.
    await withPhoneNativeContext({ nativeCall: async () => ({ ok: true, data: {} }), ownerId, sessionId: agent.sessionId }, () => action.run(args))
    const id = stableId('phone-confirmation', agent.agentUserId, job.id, callId)
    let pending = store.state.confirmations[id]
    if (!pending) {
      const code = randomUUID().slice(0, 8)
      const messageId = stableId(id, 'owner-question')
      pending = { id, code, ownerId, agentUserId: agent.agentUserId, sessionId: agent.sessionId, jobId: job.id, contextEpoch: agent.contextEpoch ?? null, actionName: action.name, args: structuredClone(args), usedGroups: structuredClone(job.usedGroups ?? []), permissionRequirements: structuredClone(job.permissionRequirements ?? []), originRoute: job.route, question: described.question, messageId, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
      store.state.confirmations[id] = pending
      await store.save()
    }
    if (pending.status !== 'pending') return result({ ok: false, code: pending.status, message: 'This confirmation has ended; check the actual result before starting again.' })
    await preflight(agent, [action.group], signal)
    await check(agent, job.usedGroups ?? [], signal, job.permissionRequirements ?? [])
    job.waitingConfirmation = pending.id
    await store.save()
    emit({ type: 'confirmation_pending', ownerId, sessionId: agent.sessionId, confirmationId: pending.id })
    return result({ ok: false, code: 'needs_confirmation', confirmation_id: pending.id, message: "Asked the owner for confirmation in this task's timeline. It runs only after the owner explicitly approves on the phone task page; you cannot confirm it yourself.", question: pending.question })
  }

  return {
    reconcile,
    tools({ agent, job }) { return [
      { name: 'phone_actions', label: 'View phone capabilities', description: 'Lists the controlled actions this phone offers, their parameters and current permission status. Phone and system permissions are checked on this phone at execution time.', parameters: { type: 'object', properties: { group: { type: 'string' } } },
        execute: async (_callId, args) => result({ actions: PHONE_ACTIONS.filter((action) => !args.group || action.group === args.group).map((action) => {
          const registered = getManifest().find((entry) => entry.name === action.name)
          const inputSchema = { ...action.input_schema, properties: Object.fromEntries(Object.entries(action.input_schema.properties ?? {}).filter(([name]) => name !== 'confirmed')) }
          return { name: action.name, group: action.group, title: action.title, description: phoneFileDescriptions[action.name] ?? action.description({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffset: utcOffsetOf(new Date()) }), input_schema: inputSchema, confirm: action.confirm, available: registered?.available ?? false, unavailable_detail: registered?.unavailable_detail ?? null }
        }) }) },
      { name: 'phone_call', label: 'Use phone capability', description: "Runs a controlled phone action listed by phone_actions. name is the action name; fill args per that action's parameters. For actions that need confirmation, the host asks the real owner to approve in the task timeline; you cannot confirm them yourself or fill in confirmed/approval. Media files are saved in this session's private directory and can be sent with message_send_file.", parameters: { type: 'object', required: ['name', 'args'], properties: { name: { type: 'string' }, args: { type: 'object', additionalProperties: true } } },
        execute: async (callId, raw, signal) => {
          try {
            const { action, args } = input(raw.name, raw.args)
            if (action.confirm === 'always') return await askOwner(agent, job, action, args, callId, signal)
            const completed = await execute({ agent, job, action, args, signal, callId })
            return result({ ok: true, data: completed.data }, completed.content)
          } catch (error) { return result({ ok: false, code: error.code ?? 'execution_failed', message: error.message }) }
        } },
    ] },

    confirmationForMessage() { return null },

    settlements(agent) { return Object.values(store.state.confirmations).filter((pending) => pending.agentUserId === agent.agentUserId && pending.contextEpoch === (agent.contextEpoch ?? null)).map(phoneConfirmationSettlement) },

    async resetContext(agent) {
      for (const pending of Object.values(store.state.confirmations)) if (pending.agentUserId === agent.agentUserId && ['pending', 'approved'].includes(pending.status)) {
        pending.status = 'cancelled'; pending.finishedAt = new Date().toISOString(); pending.error = 'Phone data permission has changed and the earlier confirmation is no longer valid; start the action again'
      }
      await store.save()
    },

    async respond(agent, input, source, admit) {
      if (source?.kind !== 'native-ui' || source.ownerId !== ownerId) throw failure('not_granted', '手机操作需要主人在这台手机的任务页确认，其他 Agent 不能代替主人批准')
      if (input.kind !== 'permission' || !confirmationOptions.some((option) => option.optionId === input.optionId)) throw failure('invalid_args', '这条手机操作的确认选项无效')
      const pending = store.state.confirmations[input.itemId]
      if (!pending || pending.ownerId !== ownerId || pending.agentUserId !== agent.agentUserId || pending.sessionId !== agent.sessionId || pending.contextEpoch !== (agent.contextEpoch ?? null)) throw failure('not_granted', '这条手机操作不属于当前主人和任务上下文')
      await check(agent, [], undefined)
      if (pending.status !== 'pending') return { accepted: false, settlement: phoneConfirmationSettlement(pending) }
      if (Date.parse(pending.expiresAt) <= Date.now()) { pending.status = 'expired'; pending.finishedAt = new Date().toISOString(); await store.save(); return { accepted: false, settlement: phoneConfirmationSettlement(pending) } }
      // Claim before the first asynchronous admission. Pending and its response job are saved
      // together by admit, so a second click cannot enqueue another native operation.
      const responseId = stableId(pending.id, 'task-response')
      pending.status = 'approved'; pending.responseOption = input.optionId; pending.respondedBy = source.ownerId; pending.respondedAt = new Date().toISOString()
      await admit({ id: responseId, agentUserId: agent.agentUserId, kind: 'confirmation', confirmationId: pending.id,
        confirmationDecision: input.optionId === 'approve' ? 'approve' : 'cancel',
        confirmationSource: { kind: 'task', messageId: responseId, senderUserId: ownerId, sessionId: agent.sessionId },
        prompt: input.optionId === 'approve' ? `The owner approved this phone action on the task page: ${pending.question}` : `The owner cancelled this phone action on the task page: ${pending.question}`,
        route: { kind: 'task', senderUserId: ownerId, personalAdmission: 'owner-input' } })
      return { accepted: true, settlement: phoneConfirmationSettlement(pending) }
    },

    async cancel(agent, options = {}) {
      for (const pending of Object.values(store.state.confirmations)) if (pending.agentUserId === agent.agentUserId && (!options.jobId || pending.jobId === options.jobId) && ['pending', 'approved'].includes(pending.status)) { pending.status = 'cancelled'; pending.finishedAt = new Date().toISOString() }
      await store.save()
    },

    async runConfirmation(agent, job, signal) {
      const pending = store.state.confirmations[job.confirmationId]
      const source = job.confirmationSource
      const taskSource = source?.kind === 'task' && source.sessionId === agent.sessionId && pending?.respondedBy === ownerId && source.messageId === stableId(pending?.id, 'task-response')
      if (!pending || pending.agentUserId !== agent.agentUserId || pending.ownerId !== ownerId || source?.senderUserId !== ownerId || !taskSource || source?.messageId !== job.id || pending.contextEpoch !== (agent.contextEpoch ?? null)) throw failure('not_granted', '确认来源与当前主人、操作或任务上下文不匹配')
      if (pending.status !== 'approved') return { ok: false, code: pending.status, message: pending.error ?? 'This action has already been handled and cannot run again.' }
      if (Date.parse(pending.expiresAt) <= Date.now()) { pending.status = 'expired'; await store.save(); return { ok: false, code: 'expired', message: 'The confirmation has expired; start the action again.' } }
      if (job.confirmationDecision === 'cancel') { pending.status = 'cancelled'; await store.save(); return { ok: false, code: 'cancelled', message: 'The owner cancelled this action.' } }
      const action = phoneActionByName(pending.actionName)
      if (!action || action.confirm !== 'always') throw failure('invalid_args', '这次确认对应的手机动作已改变')
      await preflight(agent, [action.group], signal)
      await check(agent, pending.usedGroups ?? [], signal, pending.permissionRequirements ?? [])
      pending.status = 'executing'; pending.approvedByMessageId = source.messageId
      await store.save()
      let outcome
      try {
        signal?.throwIfAborted()
        const completed = await execute({ agent, job, action, args: pending.args, signal, approval: { ownerId, actionName: action.name, requestId: pending.id, sourceMessageId: source.messageId, approved: true }, callId: pending.id })
        outcome = { ok: true, action: action.name, data: completed.data }
        pending.status = 'done'; pending.outcome = outcome
      } catch (error) {
        const unconfirmed = signal?.aborted || ['execution_unknown', 'timeout'].includes(error.code)
        outcome = unconfirmed ? { ok: false, action: action.name, code: 'execution_unknown', message: `${signal?.aborted ? 'The task was cancelled during execution' : 'The native phone call could not confirm completion'}; the result is not confirmed, check the phone. It must not be repeated automatically.` }
          : { ok: false, action: action.name, code: error.code ?? 'execution_failed', message: error.message }
        pending.status = unconfirmed ? 'interrupted' : 'failed'; pending.error = outcome.message
      }
      pending.finishedAt = new Date().toISOString(); await store.save()
      if (pending.originRoute?.kind === 'session-direct' && pending.originRoute.caller?.sessionId) {
        await check(agent, job.usedGroups ?? [], undefined, job.permissionRequirements ?? [])
        await sendSession(agent, [pending.originRoute.caller.sessionId], `Phone action confirmation handled: ${JSON.stringify(outcome)}`, { reply_to_message_id: pending.originRoute.sourceMessageId }, stableId(pending.id, 'confirmed-result'))
      }
      return outcome
    },

    async runDeviceAction(name, args, context) {
      const action = phoneActionByName(name)
      if (!action) return { ok: false, code: 'unknown_action', message: `This phone has no ${name} action` }
      if (action.confirm === 'always' && args.confirmed !== true) return { ok: false, code: 'needs_confirmation', message: action.confirmQuestion?.(args)?.question ?? `Let the phone run "${action.title}"?` }
      const agent = { sessionId: stableId('device-action', context.callId) }
      try {
        const completed = await execute({ agent, action, args, signal: context.signal, origin: 'device-rpc', callId: context.callId, approval: action.confirm === 'always' ? { confirmed: true, callId: context.callId } : undefined })
        return { ok: true, data: completed.data }
      } catch (error) { return { ok: false, code: error.code === 'execution_unknown' ? 'execution_failed' : error.code ?? 'execution_failed', message: error.message } }
    },
  }
}
