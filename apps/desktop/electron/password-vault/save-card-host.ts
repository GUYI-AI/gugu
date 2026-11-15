import { z } from 'zod'
import type { PasswordUiCommand, PasswordUiReply } from '@gugu/core/shared/passwordBetaProtocol'
import { openPasswordCard, sealPasswordCard } from '@gugu/core/shared/passwordCardCipher'
import type { BetaPasswordSaves } from './beta-save'

const field = z.strictObject({ id: z.string().uuid(), name: z.string().trim().min(1).max(200), value: z.string().max(65536), secret: z.boolean().optional() })
const reference = z.strictObject({ id: z.string().uuid(), version: z.number().int().positive(), epoch: z.string().min(1).max(200) })
const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshot') }),
  z.strictObject({ type: z.literal('save-draft'), requestId: z.string().uuid() }),
  z.strictObject({ type: z.literal('reject-save'), requestId: z.string().uuid() }),
  z.strictObject({ type: z.literal('save'), requestId: z.string().uuid(), origin: z.string().url(), name: z.string().max(200).optional(),
    account: z.string().max(4096), accountSecret: z.boolean().optional(), password: z.string().max(65536), fields: z.array(field).max(64),
    sites: z.array(z.string().url()).max(64).optional(), reference: reference.optional() }),
])
const envelope = z.strictObject({ requestId: z.string().uuid(), sealed: z.string().min(1).max(8_000_000) })
const openedSchema = z.strictObject({ requestId: z.string().uuid(), nonce: z.string().uuid(), replyKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), command: commandSchema })
/** Person card endpoint, separate from the Agent tools. Every command is scoped to one still-pending request. */
export function passwordSaveCardHandler(load: () => Promise<{ ownerId: string; saves: BetaPasswordSaves; invoke(command: PasswordUiCommand): Promise<PasswordUiReply> }>) {
  return async (payload: unknown, ctx: { request: { user_id: string } }) => {
    try {
      const value = await load()
      if (ctx.request.user_id !== value.ownerId) throw new Error('unavailable')
      const input = envelope.parse(payload), pending = value.saves.card(input.requestId)
      const opened = openedSchema.parse(await openPasswordCard(pending.key, input.sealed))
      const command = opened.command
      if (opened.requestId !== input.requestId || command.type !== 'snapshot' && command.requestId !== input.requestId) throw new Error('unavailable')
      if (command.type === 'save' && (command.origin !== pending.view.origin || command.reference?.id !== pending.view.credentialId)) throw new Error('unavailable')
      if (pending.result !== 'pending' && command.type !== 'snapshot') throw new Error('unavailable')
      const reply = await value.invoke(command)
      // A remote card cannot enumerate the vault, manage grants or reveal a stored secret.
      const scoped: PasswordUiReply = reply.ok ? { ok: true, snapshot: { items: reply.snapshot.items.filter(item => item.reference.id === pending.view.credentialId),
        approvals: [], saves: reply.snapshot.saves.filter(request => request.requestId === input.requestId), candidates: [], outcomes: reply.snapshot.outcomes?.filter(outcome => outcome.requestId === input.requestId) }, ...(reply.draft ? { draft: reply.draft } : {}) } : reply
      return { result: { sealed: await sealPasswordCard(opened.replyKey, { requestId: input.requestId, nonce: opened.nonce, reply: scoped }) } }
    } catch { return { error: { code: 'PASSWORD_CARD_UNAVAILABLE', message: '保存卡暂时无法读取，请稍后重试。' } } }
  }
}
