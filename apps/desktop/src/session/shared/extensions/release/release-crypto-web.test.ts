import { createHash as nodeHash, createPublicKey as nodePublicKey, generateKeyPairSync, randomBytes, sign, verify as nodeVerify } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { createHash, createPublicKey, verify } from './release-crypto-web';

// #1931 The page's stand-in for the three `node:crypto` names the release contract imports: Ed25519 only, and the same
// answers as Node's for every signature the contract can be handed.
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const littleEndian = (value: bigint) => Uint8Array.from({ length: 32 }, (_, at) => Number((value >> BigInt(8 * at)) & 0xffn));
const valueOf = (bytes: Uint8Array) => bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);

describe('the page bundle\'s node:crypto for the release contract', () => {
  it('reads an Ed25519 SPKI PEM as Node does, and any other key as a type the contract refuses', () => {
    const { publicKey, pem } = keyPair();
    const key = createPublicKey(pem);
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(Buffer.from(key.raw!).toString('base64url')).toBe(publicKey.export({ format: 'jwk' }).x);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(createPublicKey(rsa)).toEqual({ asymmetricKeyType: 'unsupported', raw: null });
    expect(() => createPublicKey('not a key')).toThrow(/not an SPKI PEM/);
    expect(() => createPublicKey(null)).toThrow(/not an SPKI PEM/);
  });

  it('agrees with Node on valid, changed, cross-key and non-canonical signatures', () => {
    for (let round = 0; round < 32; round++) {
      const signer = keyPair();
      const other = keyPair();
      const message = randomBytes(1 + (round * 37) % 900);
      const signature = sign(null, message, signer.privateKey);
      const key = createPublicKey(signer.pem);
      const changed = Uint8Array.from(message);
      changed[round % changed.length]! ^= 1;
      const flipped = Uint8Array.from(signature);
      flipped[round % 64]! ^= 0x80;
      // S + L encodes the same scalar mod L: RFC 8032 (and Node's OpenSSL) refuse it, ZIP-215 would not.
      const nonCanonical = Uint8Array.from([...signature.subarray(0, 32), ...littleEndian(valueOf(signature.subarray(32)) + L)]);
      for (const [data, sig, publicKey, nodeKey] of [
        [message, signature, key, signer.publicKey],
        [changed, signature, key, signer.publicKey],
        [message, flipped, key, signer.publicKey],
        [message, signature, createPublicKey(other.pem), other.publicKey],
        [message, nonCanonical, key, signer.publicKey],
      ] as const) {
        expect(verify(null, data, publicKey, sig)).toBe(nodeVerify(null, data, nodeKey, sig));
      }
      expect(verify(null, message, key, signature)).toBe(true);
      expect(verify(null, message, key, nonCanonical)).toBe(false);
    }
  });

  it('answers as Node does where the cofactored equation would not: a small-order R is refused', () => {
    // R = the order-4 point (y = 0), S = k·a: [8]SB = [8]R + [8]kA holds (ZIP-215), SB = R + kA does not (RFC 8032).
    const secret = randomBytes(32);
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(secret);
    const message = randomBytes(48);
    const R = new Uint8Array(32);
    const k = valueOf(nodeHash('sha512').update(R).update(pointBytes).update(message).digest()) % L;
    const signature = Uint8Array.from([...R, ...littleEndian((k * scalar) % L)]);
    expect(ed25519.verify(signature, message, pointBytes, { zip215: true })).toBe(true);
    // noble's strict mode alone takes it too (it checks the cofactored equation): the stand-in adds what OpenSSL means.
    expect(ed25519.verify(signature, message, pointBytes, { zip215: false })).toBe(true);
    const pem = nodePublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pointBytes]), format: 'der', type: 'spki' });
    expect(nodeVerify(null, message, pem, signature)).toBe(false);
    expect(verify(null, message, createPublicKey(pem.export({ type: 'spki', format: 'pem' }).toString()), signature)).toBe(false);
  });

  it('verifies nothing but Ed25519: another algorithm throws, another key type or length is false; no hashing here', () => {
    const { privateKey, pem } = keyPair();
    const message = randomBytes(64);
    const signature = sign(null, message, privateKey);
    expect(() => verify('sha256', message, createPublicKey(pem), signature)).toThrow(/only Ed25519/);
    expect(verify(null, message, { asymmetricKeyType: 'unsupported', raw: null }, signature)).toBe(false);
    expect(verify(null, message, createPublicKey(pem), signature.subarray(0, 63))).toBe(false);
    expect(() => createHash()).toThrow(/not available in the page bundle/);
  });
});
