/**
 * Test utilities for provider-account DB integration tests (main-db project).
 *
 * Opens a real SQLite fixture and wires a real ProviderAccountRegistry to it.
 * Only the secret store is in-memory, because encryptedAppSecretsStore depends
 * on Electron safeStorage which is unavailable under plain Node. The password
 * vault is in-memory too: what it saves lands in the same map at `vault:<id>`,
 * the ref the real router sends to the vault.
 */

import {
  ProviderAccountRegistry,
  type ProviderAccountSecretStore,
} from '@main/core/provider-accounts/provider-account-registry';
import { openFixture, type FixtureDb } from './db';

export class InMemorySecretStore implements ProviderAccountSecretStore {
  readonly secrets = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.secrets.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.secrets.delete(key);
  }
}

export type VaultSave = { origin: string; name: string; account: string; password: string };

export class InMemoryVault {
  readonly saved = new Map<string, Omit<VaultSave, 'password'>>();
  private next = 0;
  constructor(private readonly secretStore: InMemorySecretStore) {}

  async save(input: VaultSave, credentialId?: string): Promise<string> {
    const id = credentialId ?? `cred-${++this.next}`;
    const { password, ...summary } = input;
    this.saved.set(id, summary);
    this.secretStore.secrets.set(`vault:${id}`, password);
    return id;
  }
}

export type RegistryFixture = FixtureDb & {
  registry: ProviderAccountRegistry;
  secretStore: InMemorySecretStore;
  vault: InMemoryVault;
};

/** Open a fixture database with a real ProviderAccountRegistry on top of it. */
export async function openRegistryFixture(
  name: Parameters<typeof openFixture>[0] = 'empty'
): Promise<RegistryFixture> {
  const fixture = await openFixture(name);
  const secretStore = new InMemorySecretStore();
  const registry = new ProviderAccountRegistry(fixture.db, secretStore);
  return { ...fixture, registry, secretStore, vault: new InMemoryVault(secretStore) };
}
