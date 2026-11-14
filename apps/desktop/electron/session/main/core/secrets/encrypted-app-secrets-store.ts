import { and, eq } from 'drizzle-orm';
import { safeStorage } from 'electron';
import { db as appDb, type AppDb, type DrizzleTx } from '@main/db/client';
import { appSecrets } from '@main/db/schema';
import { SecureStorageUnavailableError } from './secure-storage-unavailable';

export class EncryptedAppSecretsStore {
  constructor(
    private readonly db = appDb,
    private readonly safeStorageApi = safeStorage,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async getSecret(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ secret: appSecrets.secret })
      .from(appSecrets)
      .where(eq(appSecrets.key, key))
      .limit(1);

    const secret = rows[0]?.secret;
    if (!secret) {
      return null;
    }

    this.assertSecureStorageAvailable();
    return this.safeStorageApi.decryptString(Buffer.from(secret, 'base64'));
  }

  /** Sealed bytes and plaintext from one read; the sealed value is part of the
   * generation a later conditional write must still find. */
  atomicSecretSnapshot(db: AppDb | DrizzleTx, key: string): { sealed: string; secret: string } | null {
    const sealed = db.select({ secret: appSecrets.secret }).from(appSecrets).where(eq(appSecrets.key, key)).get()?.secret;
    if (!sealed) return null;
    this.assertSecureStorageAvailable();
    return { sealed, secret: this.safeStorageApi.decryptString(Buffer.from(sealed, 'base64')) };
  }

  /** Encrypt before entering SQLite; the returned write replaces only the exact
   * sealed bytes captured at the original read, inside the caller's transaction. */
  async atomicSecretCompareAndSwap(db: AppDb, key: string, expectedSealed: string, replacement: string): Promise<(tx: DrizzleTx) => boolean> {
    if (db !== this.db) throw new Error('Secret compare-and-swap needs this store\'s own database');
    this.assertSecureStorageAvailable();
    const sealed = this.safeStorageApi.encryptString(replacement).toString('base64');
    return (tx) => tx.update(appSecrets).set({ secret: sealed })
      .where(and(eq(appSecrets.key, key), eq(appSecrets.secret, expectedSealed))).run().changes === 1;
  }

  async setSecret(key: string, secret: string): Promise<void> {
    this.assertSecureStorageAvailable();
    const encryptedSecret = this.safeStorageApi.encryptString(secret).toString('base64');

    await this.setEncryptedSecret(key, encryptedSecret);
  }

  async setEncryptedSecret(key: string, encryptedSecret: string): Promise<void> {
    await this.db
      .insert(appSecrets)
      .values({
        key: key,
        secret: encryptedSecret,
      })
      .onConflictDoUpdate({ target: appSecrets.key, set: { secret: encryptedSecret } })
      .execute();
  }

  async deleteSecret(key: string): Promise<void> {
    await this.db.delete(appSecrets).where(eq(appSecrets.key, key));
  }

  private assertSecureStorageAvailable(): void {
    if (!this.safeStorageApi.isEncryptionAvailable()) {
      throw new SecureStorageUnavailableError('Secure secret storage is unavailable on this system.');
    }

    if (this.platform !== 'linux') {
      return;
    }

    const backend = this.safeStorageApi.getSelectedStorageBackend?.();
    if (backend === 'basic_text') {
      throw new SecureStorageUnavailableError(
        'Secure secret storage is unavailable: Linux safeStorage backend is basic_text.'
      );
    }
  }
}

export const encryptedAppSecretsStore = new EncryptedAppSecretsStore();
