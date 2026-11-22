import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import type { AppDb } from '@main/db/client';
import { providerAccounts, sessions, automations, kv, appSettings } from '@main/db/schema';
import { customModelOptionId, customModelRefFromOption, type ModelProtocol } from '@gugu/session-core/models/custom-model';

/** The released connection declarations, retained only to interpret old records. */
const legacyEndpoints: Record<string, { protocol: ModelProtocol; baseUrl?: string }> = {
  claude: { protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  codex: { protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  dsh: { protocol: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' },
  qwen: { protocol: 'openai-chat-completions', baseUrl: 'https://api.openai.com/v1' },
  copilot: { protocol: 'openai-chat-completions', baseUrl: 'https://api.openai.com/v1' },
  zcode: { protocol: 'openai-chat-completions', baseUrl: 'https://api.openai.com/v1' },
  codebuddy: { protocol: 'openai-chat-completions', baseUrl: 'https://api.openai.com/v1' },
  hermes: { protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  opencode: { protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  pi: { protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  antigravity: { protocol: 'gemini-generate-content' },
};

/** An old ACP adapter could report “provider/model” whereas the connection stored the upstream ID. */
function legacyModelId(model: string | undefined, listed: readonly string[]): string | undefined {
  if (!model) return listed[0];
  if (listed.includes(model)) return model;
  const slash = model.indexOf('/');
  const name = slash < 0 ? undefined : model.slice(slash + 1);
  return name && listed.includes(name) ? name : model;
}

export type CustomModelMigration = {
  namespace: string; from: string;
  /** `models:custom/<id>` a former API connection moved to; absent when only its vendor-key marker was set. */
  to?: string; sessions: number; automations: number;
};

/** Atomic metadata-only migration: no secret is decrypted, copied or deleted. Returns what it changed. */
export function migrateCustomModels(database: AppDb, vendorKeyProviders: ReadonlySet<string>): CustomModelMigration[] {
  const migrated: CustomModelMigration[] = [];
  database.transaction((tx) => {
    const customRows = tx.select().from(providerAccounts).where(eq(providerAccounts.providerId, 'models:custom')).all();
    const byRef = new Map(customRows.map((row) => [row.credentialRef, row.accountId]));
    const legacyRows = tx.select().from(providerAccounts).where(like(providerAccounts.providerId, 'harness:%')).all().filter((row) => {
      const old = row.meta?.harnessConnection;
      if (old?.kind !== 'api-key') return false;
      if (vendorKeyProviders.has(row.providerId.slice('harness:'.length))) return row.meta?.credentialSource !== 'vendor-key';
      return !old.migratedTo || old.migratedTo !== byRef.get(row.credentialRef);
    });
    if (legacyRows.length === 0) return;
    const platformRows = new Map(tx.select().from(kv).where(like(kv.key, 'sessionpage-platform-model:%')).all().map((row) => [row.key.slice('sessionpage-platform-model:'.length), JSON.parse(row.value) as { platformModel?: unknown }]));
    const automationRows = tx.select().from(automations).all();
    const sessionRows = tx.select().from(sessions).all();
    for (const row of legacyRows) {
      const old = row.meta?.harnessConnection;
      if (old?.kind !== 'api-key') continue;
      const providerId = row.providerId.slice('harness:'.length);
      if (vendorKeyProviders.has(providerId)) {
        if (row.meta?.credentialSource !== 'vendor-key') {
          tx.update(providerAccounts).set({ meta: { ...row.meta!, credentialSource: 'vendor-key' } })
            .where(eq(providerAccounts.id, row.id)).run();
          migrated.push({ namespace: row.providerId, from: row.accountId, sessions: 0, automations: 0 });
        }
        continue;
      }
      const legacy = legacyEndpoints[providerId];
      if (!legacy) throw new Error(`Cannot migrate the API connection for unknown harness ${providerId}`);
      const baseUrl = old.endpoint ?? legacy.baseUrl;
      if (!baseUrl) throw new Error(`The saved ${providerId} connection has no API address`);
      let id = byRef.get(row.credentialRef);
      if (!id) {
        id = randomUUID();
        tx.insert(providerAccounts).values({
          id: randomUUID(), providerId: 'models:custom', accountId: id,
          credentialRef: row.credentialRef,
          isDefault: customRows.length === 0 && byRef.size === 0,
          meta: {
            version: '1', displayName: row.meta?.displayName || providerId,
            customModel: {
              preset: null,
              endpoints: [{ protocol: old.protocol ?? legacy.protocol, baseUrl }],
              models: (old.models?.length ? old.models : old.model ? [old.model] : []).map((modelId) => ({ id: modelId })),
              ...(old.removed ? { removed: true } : {}),
            },
          },
          createdAt: row.createdAt, updatedAt: Date.now(),
        }).run();
        byRef.set(row.credentialRef, id);
      }
      const listed = old.models?.length ? old.models : old.model ? [old.model] : [];
      if (old.migratedTo === id) continue;
      tx.update(providerAccounts).set({ meta: { ...row.meta!, harnessConnection: { ...old, migratedTo: id } } })
        .where(eq(providerAccounts.id, row.id)).run();
      const moved: CustomModelMigration = { namespace: row.providerId, from: row.accountId, to: `models:custom/${id}`, sessions: 0, automations: 0 };
      migrated.push(moved);
      for (const session of sessionRows) {
        if (session.provider !== providerId || !session.config || customModelRefFromOption(session.config.model)) continue;
        if (session.config.subscriptionConnectionId !== row.accountId && !(row.isDefault && !session.config.subscriptionConnectionId)) continue;
        if (platformRows.get(session.id)?.platformModel) continue;
        const modelId = legacyModelId(session.config.model, listed);
        tx.update(sessions).set({
          config: { ...session.config, model: customModelOptionId({ connectionId: id, modelId }) },
        }).where(eq(sessions.id, session.id)).run();
        moved.sessions += 1;
        tx.insert(kv).values({ key: `sessionpage-platform-model:${session.id}`, value: JSON.stringify({ platformModel: null }) }).onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify({ platformModel: null }) } }).run();
      }

      if (row.isDefault && !old.removed) {
        for (const automation of automationRows) {
          const config = automation.agentConfig;
          if (!config || config.provider !== providerId || config.platformModel || customModelRefFromOption(config.model)) continue;
          const model = customModelOptionId({ connectionId: id, modelId: legacyModelId(config.model, listed) });
          tx.update(automations).set({ agentConfig: { ...config, model, platformModel: null } }).where(eq(automations.id, automation.id)).run();
          moved.automations += 1;
        }
        const memory = tx.select().from(appSettings).where(eq(appSettings.key, 'newSessionMemory')).get();
        if (memory) {
          const value = JSON.parse(memory.value);
          const last = value.lastStarted;
          if (last?.provider === providerId && !last.platformModel && !customModelRefFromOption(last.model)) {
            value.lastStarted.model = customModelOptionId({ connectionId: id, modelId: legacyModelId(last.model, listed) });
            tx.update(appSettings).set({ value: JSON.stringify(value) }).where(eq(appSettings.key, memory.key)).run();
          }
        }
      }
    }
  });
  return migrated;
}
