import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** A process-local authenticated capsule. Positions/ranges never become wire
 * fields, and a new gateway cannot accept the preceding gateway's handles. */
export function createWindowProjectionHandles() {
  const key = randomBytes(32);
  return {
    seal(value: object): string {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 2048) throw new Error('Projection handle exceeds its bound');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
    },
    open(token: string): unknown {
      if (typeof token !== 'string' || token.length < 40 || token.length > 2800 || !/^[A-Za-z0-9_-]+$/.test(token))
        throw new Error('Invalid projection handle');
      const bytes = Buffer.from(token, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
    },
  };
}
