import { z } from 'zod'
import { sign, verifySignature, type DeviceKeyPair } from './sync-crypto'

/**
 * Signed membership (SYNC.md): which devices hold the vault key and which key is current, as the devices themselves
 * signed it. The cloud stores and orders the entries but cannot write one: a device accepts an entry only when a full
 * member of the entry before it (or the recovery code it names) signed it. So the cloud can neither slip in a device
 * nor hand out a key of its own unnoticed. Pure: no network, no disk.
 */
export interface Member { id: string; key: string; scope: 'full' | 'granted' }
/** signer: a member's device id, or RECOVERY_SIGNER when the recovery code admitted a device. */
export interface MemberSnapshot { owner: string; seq: number; epoch: number; keyHash: string; members: Member[]; recovery: string | null; signer: string }
export interface LogEntry { seq: number; body: string; signature: string; attestation: string | null }
export const RECOVERY_SIGNER = 'recovery'

const byId = (members: Member[]) => [...members].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
/** The exact signed text: fixed field order, members sorted, so every device computes the same bytes. */
export function snapshotText(value: MemberSnapshot): string {
  const members = byId(value.members).map(member => [member.id, member.key, member.scope])
  return JSON.stringify(['gugu-vault-members-v1', value.owner, value.seq, value.epoch, value.keyHash, members, value.recovery, value.signer])
}
/** The recovery code vouches for the entry that set it, so a device holding only the code can find the true chain. */
const attestationText = (body: string) => JSON.stringify(['gugu-vault-recovery-v1', body])

const key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
const bodySchema = z.tuple([z.literal('gugu-vault-members-v1'), z.string().min(1), z.number().int().positive(), z.number().int().positive(),
  z.string().regex(/^[0-9a-f]{64}$/), z.array(z.tuple([z.string().min(1), key, z.enum(['full', 'granted'])])), key.nullable(), z.string().min(1)])
export function parseSnapshot(body: string): MemberSnapshot | undefined {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return undefined }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return undefined
  const [, owner, seq, epoch, keyHash, members, recovery, signer] = parsed.data
  const value: MemberSnapshot = { owner, seq, epoch, keyHash, members: members.map(([id, memberKey, scope]) => ({ id, key: memberKey, scope })), recovery, signer }
  // Only the one text of this snapshot, and every device listed once.
  return snapshotText(value) === body && new Set(value.members.map(member => member.id)).size === value.members.length ? value : undefined
}

/** The entry after `from` (none: the vault's first). attest: the new recovery code also signs it. */
export async function writeEntry(owner: string, from: MemberSnapshot | undefined, change: Pick<MemberSnapshot, 'epoch' | 'keyHash' | 'members' | 'recovery'>,
  signer: { id: string; pair: DeviceKeyPair }, attest?: DeviceKeyPair): Promise<{ snapshot: MemberSnapshot; entry: LogEntry }> {
  const snapshot: MemberSnapshot = { owner, seq: (from?.seq ?? 0) + 1, epoch: change.epoch, keyHash: change.keyHash, members: byId(change.members),
    recovery: change.recovery, signer: signer.id }
  const body = snapshotText(snapshot)
  return { snapshot, entry: { seq: snapshot.seq, body, signature: await sign(signer.pair, body), attestation: attest ? await sign(attest, attestationText(body)) : null } }
}

/** The entry after `trusted`, if a full member of `trusted` (or its recovery code, which is then used up) signed it.
 * The key stays the same within an epoch; only a re-key moves on, one epoch at a time. */
async function follow(owner: string, trusted: MemberSnapshot, entry: LogEntry): Promise<MemberSnapshot | undefined> {
  const next = parseSnapshot(entry.body)
  if (!next || next.owner !== owner || entry.seq !== next.seq || next.seq !== trusted.seq + 1) return undefined
  if (next.epoch === trusted.epoch ? next.keyHash !== trusted.keyHash : next.epoch !== trusted.epoch + 1) return undefined
  if (next.signer === RECOVERY_SIGNER && next.recovery !== null) return undefined
  const signerKey = next.signer === RECOVERY_SIGNER ? trusted.recovery : trusted.members.find(member => member.id === next.signer && member.scope === 'full')?.key
  return signerKey && await verifySignature(signerKey, entry.body, entry.signature) ? next : undefined
}

/** Where a device with nothing trusted yet may start. pending: an entry it wrote itself while not a member (creating
 * the vault, recovering). approverKey + self: an entry the device whose code the person compared signed, listing this
 * device under its key. recoveryKey: the entry the recovery code vouched for when it was made. */
export interface Anchor { pending?: string; approverKey?: string; self?: { id: string; key: string }; recoveryKey?: string }
async function anchors(owner: string, entry: LogEntry, anchor: Anchor): Promise<boolean> {
  const value = parseSnapshot(entry.body)
  if (!value || value.owner !== owner || value.seq !== entry.seq) return false
  if (anchor.pending && entry.body === anchor.pending) return true
  const { approverKey, self, recoveryKey } = anchor
  if (approverKey && self && value.members.some(member => member.id === self.id && member.key === self.key)
    && value.members.some(member => member.id === value.signer && member.key === approverKey && member.scope === 'full')
    && await verifySignature(approverKey, entry.body, entry.signature)) return true
  return !!recoveryKey && value.recovery === recoveryKey && !!entry.attestation && await verifySignature(recoveryKey, attestationText(entry.body), entry.attestation)
}

/** Follows the log to its head from what this device already trusts, or from the newest entry it may start from.
 * Undefined when the chain breaks anywhere: a gap, a forged signature, a key swapped without a re-key. */
export async function verifyLog(owner: string, log: LogEntry[], start: { trusted: MemberSnapshot } | Anchor): Promise<MemberSnapshot | undefined> {
  let current: MemberSnapshot | undefined, rest = log
  if ('trusted' in start) current = start.trusted
  else {
    for (let index = log.length - 1; index >= 0; index--) {
      if (!(await anchors(owner, log[index]!, start))) continue
      current = parseSnapshot(log[index]!.body); rest = log.slice(index + 1)
      break
    }
  }
  for (const entry of rest) { if (!current) return undefined; current = await follow(owner, current, entry) }
  return current
}
