import { describe, expect, it } from 'vitest'
import { aad, boxed, commitment, createDeviceKeyPair, keyHash, normalizeRecoveryCode, openSealed, openVaultKey, randomKey, randomNonce, recoveryCode, recoveryKeys, sealTo, sealVaultKey, shortCode, sign, unboxed, verifyCommitment, verifySignature } from '../../../apps/desktop/electron/password-vault/sync-crypto'

describe('vault sync crypto', () => {
  it('a sealed share opens only with the matching device key', async () => {
    const device = await createDeviceKeyPair(), other = await createDeviceKeyPair()
    const sealed = await sealTo(device.publicKey, Buffer.from('canary-vault-key'))
    expect(sealed).not.toContain('canary')
    expect((await openSealed(device, sealed)).toString()).toBe('canary-vault-key')
    await expect(openSealed(other, sealed)).rejects.toThrow('DATA_DAMAGED')
  })
  it('binds a vault key share to its epoch', async () => {
    const device = await createDeviceKeyPair(), key = randomKey()
    const sealed = await sealVaultKey(device.publicKey, 3, key)
    expect((await openVaultKey(device, 3, sealed)).equals(key)).toBe(true)
    await expect(openVaultKey(device, 4, sealed)).rejects.toThrow('DATA_DAMAGED')
  })
  it('the commitment hides the nonce and binds the key', async () => {
    const device = await createDeviceKeyPair(), swapped = await createDeviceKeyPair(), nonce = randomNonce()
    const commit = commitment(device.publicKey, nonce)
    expect(verifyCommitment(device.publicKey, nonce, commit)).toBe(true)
    expect(verifyCommitment(swapped.publicKey, nonce, commit)).toBe(false)
    expect(verifyCommitment(device.publicKey, randomNonce(), commit)).toBe(false)
  })
  it('both sides derive the same 6 digits; any changed input, the approver key included, changes them', async () => {
    const device = await createDeviceKeyPair(), approver = await createDeviceKeyPair(), deviceNonce = randomNonce(), approverNonce = randomNonce()
    const code = shortCode(device.publicKey, deviceNonce, approverNonce, approver.publicKey)
    expect(code).toMatch(/^\d{6}$/)
    expect(shortCode(device.publicKey, deviceNonce, approverNonce, approver.publicKey)).toBe(code)
    const changed = new Set([shortCode((await createDeviceKeyPair()).publicKey, deviceNonce, approverNonce, approver.publicKey),
      shortCode(device.publicKey, randomNonce(), approverNonce, approver.publicKey), shortCode(device.publicKey, deviceNonce, randomNonce(), approver.publicKey),
      shortCode(device.publicKey, deviceNonce, approverNonce, (await createDeviceKeyPair()).publicKey)])
    // A collision is possible with probability 1e-6 per pair; four independent misses are what we expect.
    expect(changed.has(code)).toBe(false)
  })
  it('one device key both signs and receives sealed shares', async () => {
    const device = await createDeviceKeyPair(), other = await createDeviceKeyPair()
    const signature = await sign(device, 'members')
    expect(await verifySignature(device.publicKey, 'members', signature)).toBe(true)
    expect(await verifySignature(device.publicKey, 'members!', signature)).toBe(false)
    expect(await verifySignature(other.publicKey, 'members', signature)).toBe(false)
    expect(await verifySignature(device.publicKey, 'members', 'not-a-signature')).toBe(false)
    const key = randomKey()
    expect(keyHash('owner', 1, key)).toBe(keyHash('owner', 1, Buffer.from(key)))
    expect(new Set([keyHash('owner', 1, key), keyHash('owner', 2, key), keyHash('other', 1, key), keyHash('owner', 1, randomKey())]).size).toBe(4)
    expect(keyHash('owner', 1, key)).not.toContain(key.toString('hex'))
  })
  it('boxes authenticate their binding', () => {
    const key = randomKey(), binding = aad('item', 'owner', 'id', 2)
    const box = boxed(key, Buffer.from('{"password":"canary"}'), binding)
    expect(unboxed(key, box, binding).toString()).toContain('canary')
    expect(() => unboxed(key, box, aad('item', 'owner', 'id', 3))).toThrow('DATA_DAMAGED')
    expect(() => unboxed(randomKey(), box, binding)).toThrow('DATA_DAMAGED')
    expect(aad('a|b', 'c')).not.toBe(aad('a', 'b|c'))
  })
  it('a recovery code is long and random, tolerant to how it is typed, and derives a key pair and an unrelated proof', async () => {
    const code = recoveryCode()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/)
    expect(new Set(Array.from({ length: 50 }, recoveryCode)).size).toBe(50)
    expect(normalizeRecoveryCode(` ${code.toLowerCase().replaceAll('-', ' ')} `)).toBe(code.replaceAll('-', ''))
    expect(normalizeRecoveryCode('OIL' + code.replaceAll('-', '').slice(3))).toBe('011' + code.replaceAll('-', '').slice(3))
    expect(normalizeRecoveryCode(code.slice(0, -1))).toBeUndefined()
    const keys = await recoveryKeys(code), again = await recoveryKeys(code.toLowerCase())
    expect(again.pair.publicKey).toBe(keys.pair.publicKey)
    expect(again.verifier).toBe(keys.verifier)
    expect(keys.verifier).not.toContain(Buffer.from(keys.proof, 'base64').toString('hex'))
    const vaultKey = randomKey(), sealed = await sealVaultKey(keys.pair.publicKey, 1, vaultKey)
    expect((await openVaultKey(again.pair, 1, sealed)).equals(vaultKey)).toBe(true)
    await expect(recoveryKeys(recoveryCode()).then(other => openVaultKey(other.pair, 1, sealed))).rejects.toThrow('DATA_DAMAGED')
    await expect(recoveryKeys('too-short')).rejects.toThrow('RECOVERY_INVALID')
  })
})
