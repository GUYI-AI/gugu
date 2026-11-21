import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { db } from '@main/db/client';
import { ProviderAccountRegistry, vaultCredentialOf, type ProviderAccountSecretStore } from './provider-account-registry';

const vault = async () => (await import('../../../../password-vault/beta-host')).passwordVaultForHost;
const secretStore: ProviderAccountSecretStore = {
  getSecret: async (key) => { const id = vaultCredentialOf(key); return id ? (await vault()).secret(id) : encryptedAppSecretsStore.getSecret(key); },
  setSecret: async (key, value) => {
    if (vaultCredentialOf(key)) throw new Error('A vault credential is saved through the vault, then its ref is given to the account');
    await encryptedAppSecretsStore.setSecret(key, value);
  },
  deleteSecret: async (key) => { const id = vaultCredentialOf(key); if (id) await (await vault()).remove(id); else await encryptedAppSecretsStore.deleteSecret(key); },
  // Conditional replacement (a refreshed OAuth token) is the app store's: no vault-kept secret is refreshed in place.
  atomicSecretSnapshot: (tx, key) => (vaultCredentialOf(key) ? null : encryptedAppSecretsStore.atomicSecretSnapshot(tx, key)),
  atomicSecretCompareAndSwap: (database, key, expected, replacement) => {
    if (vaultCredentialOf(key)) throw new Error('A vault credential is not replaced conditionally');
    return encryptedAppSecretsStore.atomicSecretCompareAndSwap(database, key, expected, replacement);
  },
};

export const providerAccountRegistry = new ProviderAccountRegistry(db, secretStore);
