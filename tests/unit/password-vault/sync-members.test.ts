import { describe, expect, it } from 'vitest'
import { createDeviceKeyPair, keyHash, randomKey, recoveryCode, recoveryKeys } from '../../../apps/desktop/electron/password-vault/sync-crypto'
import { RECOVERY_SIGNER, parseSnapshot, verifyLog, writeEntry, type LogEntry } from '../../../apps/desktop/electron/password-vault/sync-members'

const owner = 'owner-1'
/** A vault the Mac created, that the Mac then let the laptop into. */
async function vault() {
  const mac = await createDeviceKeyPair(), laptop = await createDeviceKeyPair(), stranger = await createDeviceKeyPair(), key = randomKey()
  const first = await writeEntry(owner, undefined, { epoch: 1, keyHash: keyHash(owner, 1, key), recovery: null,
    members: [{ id: 'mac', key: mac.publicKey, scope: 'full' }] }, { id: 'mac', pair: mac })
  const second = await writeEntry(owner, first.snapshot, { epoch: 1, keyHash: first.snapshot.keyHash, recovery: null,
    members: [...first.snapshot.members, { id: 'laptop', key: laptop.publicKey, scope: 'full' }] }, { id: 'mac', pair: mac })
  return { mac, laptop, stranger, first, second, log: [first.entry, second.entry] }
}

describe('signed membership', () => {
  it('follows entries signed by a full member of the entry before', async () => {
    const { first, second, log } = await vault()
    expect(await verifyLog(owner, log, { pending: first.entry.body })).toEqual(second.snapshot)
    expect(await verifyLog(owner, [second.entry], { trusted: first.snapshot })).toEqual(second.snapshot)
    expect(parseSnapshot(second.entry.body)).toEqual(second.snapshot)
  })

  it('rejects a forged signature, a signer outside the membership, a gap, another owner and a key swapped within an epoch', async () => {
    const { mac, stranger, first, second } = await vault()
    const extra = { id: 'cloud', key: stranger.publicKey, scope: 'full' as const }
    const add = { epoch: 1, keyHash: first.snapshot.keyHash, recovery: null, members: [...second.snapshot.members, extra] }
    const forged = await writeEntry(owner, second.snapshot, add, { id: 'mac', pair: stranger })
    const outsider = await writeEntry(owner, second.snapshot, add, { id: 'cloud', pair: stranger })
    const swapped = await writeEntry(owner, second.snapshot, { ...add, members: second.snapshot.members, keyHash: keyHash(owner, 1, randomKey()) }, { id: 'mac', pair: mac })
    const skipped = await writeEntry(owner, second.snapshot, { ...add, epoch: 3, members: second.snapshot.members }, { id: 'mac', pair: mac })
    const elsewhere = await writeEntry('owner-2', second.snapshot, { ...add, members: second.snapshot.members }, { id: 'mac', pair: mac })
    for (const entry of [forged.entry, outsider.entry, swapped.entry, skipped.entry, elsewhere.entry])
      expect(await verifyLog(owner, [entry], { trusted: second.snapshot })).toBeUndefined()
    // A gap, and a body that is not the one signed text.
    expect(await verifyLog(owner, [second.entry], { trusted: { ...first.snapshot, seq: 0 } })).toBeUndefined()
    const reordered: LogEntry = { ...second.entry, body: JSON.stringify(JSON.parse(second.entry.body)).replace('"gugu-vault-members-v1"', ' "gugu-vault-members-v1"') }
    expect(await verifyLog(owner, [reordered], { trusted: first.snapshot })).toBeUndefined()
    // The genuine next entry still goes through.
    const removed = await writeEntry(owner, second.snapshot, { epoch: 2, keyHash: keyHash(owner, 2, randomKey()), recovery: null, members: first.snapshot.members }, { id: 'mac', pair: mac })
    expect(await verifyLog(owner, [removed.entry], { trusted: second.snapshot })).toEqual(removed.snapshot)
  })

  it('a joining device starts from the entry its approver signed listing it; nothing else counts', async () => {
    const { mac, laptop, stranger, second, log } = await vault()
    const self = { id: 'laptop', key: laptop.publicKey }
    expect(await verifyLog(owner, log, { approverKey: mac.publicKey, self })).toEqual(second.snapshot)
    // Another approver key (the cloud's), or the laptop listed under another key: no start.
    expect(await verifyLog(owner, log, { approverKey: stranger.publicKey, self })).toBeUndefined()
    expect(await verifyLog(owner, log, { approverKey: mac.publicKey, self: { id: 'laptop', key: stranger.publicKey } })).toBeUndefined()
    // A start the cloud wrote itself, listing the laptop with the Mac's key but signed by its own key.
    const fake = await writeEntry(owner, second.snapshot, { epoch: 1, keyHash: keyHash(owner, 1, randomKey()), recovery: null, members: second.snapshot.members }, { id: 'mac', pair: stranger })
    expect(await verifyLog(owner, [fake.entry], { approverKey: mac.publicKey, self })).toBeUndefined()
  })

  it('a recovering device starts from the entry its code vouched for, and the code signs only the entry that uses it up', async () => {
    const { mac, laptop, second } = await vault()
    const code = await recoveryKeys(recoveryCode()), other = await recoveryKeys(recoveryCode())
    const set = await writeEntry(owner, second.snapshot, { ...second.snapshot, recovery: code.pair.publicKey }, { id: 'mac', pair: mac }, code.pair)
    const log = [second.entry, set.entry]
    expect(await verifyLog(owner, log, { recoveryKey: code.pair.publicKey })).toEqual(set.snapshot)
    expect(await verifyLog(owner, log, { recoveryKey: other.pair.publicKey })).toBeUndefined()
    // The cloud cannot vouch in the code's name: an entry naming the code without its signature is no start.
    const unsigned: LogEntry = { ...set.entry, attestation: null }
    expect(await verifyLog(owner, [second.entry, unsigned], { recoveryKey: code.pair.publicKey })).toBeUndefined()
    const used = await writeEntry(owner, set.snapshot, { ...set.snapshot, recovery: null,
      members: [...set.snapshot.members.filter(member => member.id !== 'laptop'), { id: 'laptop', key: laptop.publicKey, scope: 'full' }] }, { id: RECOVERY_SIGNER, pair: code.pair })
    expect(await verifyLog(owner, [used.entry], { trusted: set.snapshot })).toEqual(used.snapshot)
    const kept = await writeEntry(owner, set.snapshot, { ...set.snapshot }, { id: RECOVERY_SIGNER, pair: code.pair })
    expect(await verifyLog(owner, [kept.entry], { trusted: set.snapshot })).toBeUndefined()
    expect(await verifyLog(owner, [used.entry], { trusted: second.snapshot })).toBeUndefined()
  })
})
