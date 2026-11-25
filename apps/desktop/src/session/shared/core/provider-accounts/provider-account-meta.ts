import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';
import { customModelMetaSchema, discoverySourceSchema } from '@gugu/session-core/models/custom-model';

// ---------------------------------------------------------------------------
// v1 schema — initial version
// ---------------------------------------------------------------------------

/**
 * Display and identity metadata for a provider account. Every field is
 * optional: providers without a real account identity (single-token
 * integrations) store little or nothing here, while providers like GitHub
 * populate the full identity block. New fields must be added as optional so
 * existing rows stay valid without a schema version bump.
 */
const v1Schema = z.object({
  version: z.literal('1'),
  /** Human-readable account label, e.g. "Mona Lisa" or a Jira site name. */
  displayName: z.string().optional(),
  /** Provider login/username, e.g. "octocat". */
  login: z.string().optional(),
  avatarUrl: z.string().optional(),
  /** Provider host the account belongs to, e.g. "github.com". */
  host: z.string().optional(),
  /** The provider's own id for the account, e.g. a numeric GitHub user id. */
  providerAccountId: z.string().optional(),
  /**
   * How the credential was obtained, e.g. 'form' | 'oauth' | 'device_flow' | 'cli'.
   * `PLATFORM_CREDENTIAL_SOURCE`: the Gugu platform keeps it (#921); the row carries no secret.
   */
  credentialSource: z.string().optional(),
  /**
   * One device-owned provider connection, shared by all compatible harnesses. `discovery` marks a connection this
   * device already had configured elsewhere (identity = SHA-256 of address and key, never the key); it stays on this
   * device and is never part of what a renderer reads.
   */
  customModel: customModelMetaSchema.extend({
    discovery: z.object({
      source: discoverySourceSchema,
      identity: z.string().regex(/^[\da-f]{64}$/),
      keyLast4: z.string().max(4),
      aliases: z.array(z.string().max(200)).max(32).optional(),
    }).optional(),
    /** On a removed connection: what its key was, as identities (SHA-256 of address and key, never the key), so discovery does not list it again. */
    suppresses: z.array(z.string().regex(/^[\da-f]{64}$/)).max(16).optional(),
  }).optional(),
  /** Harness credentials belong to this device. A removed connection keeps its row (an account connection also its sign-in vault) for bound sessions, never a vendor key. */
  harnessConnection: z.object({
    kind: z.enum(['native', 'account', 'api-key']),
    /** 缺席 = 这家的官方地址(用户没改预填的那一个,#2507)。 */
    endpoint: z.string().optional(),
    /** API Key 连接点名的模型(#2507,只有声明了 `model: 'required'` 的家才有),一个或几个。 */
    models: z.array(z.string()).optional(),
    /** 修改前只能点名一个模型时存的那一格;读的时候并进 `models`。 */
    model: z.string().optional(),
    /** 建连接时按地址探出来的接口(这家讲得了不止一种时才有,#2507)。 */
    protocol: z.enum(['openai-responses', 'openai-chat-completions']).optional(),
    removed: z.boolean().optional(),
    /**
     * The row is no longer a connection of its harness, which falls back to `native`. The value only records where it
     * went: `native` for a merged Codex alias, a `models:custom` account for a former API connection (which also
     * deduplicates by credential_ref). Retained for rollback.
     */
    migratedTo: z.string().optional(),
    /** Device-local reference only. OAuth tokens remain in the native CLI's file. */
    nativeOAuth: z.object({ root: z.string(), identity: z.string(), operationId: z.string() }).optional(),
  }).optional(),
});

/**
 * #921 `credentialSource` of an account whose credential the Gugu platform keeps for the person: the row
 * mirrors the platform's answer on this device and has nothing behind its credentialRef.
 */
export const PLATFORM_CREDENTIAL_SOURCE = 'platform';

/**
 * #921 `credentialSource` of an account whose #649 key the provider rejected when it was moved to the platform: the
 * key is gone, the row stays (nothing behind its credentialRef) so the connection page asks for a key again.
 */
export const REJECTED_KEY_SOURCE = 'platform-rejected-key';

// ---------------------------------------------------------------------------
// Versioned schema
// ---------------------------------------------------------------------------

/**
 * Versioned schema for provider account metadata stored in
 * `provider_accounts.meta`. Stable identity/constraint facts (providerId,
 * accountId, credentialRef, isDefault) live in dedicated columns; everything
 * display- or identity-shaped lives here so it can evolve additively.
 */
export const providerAccountMeta = defineVersionedSchema().initial('1', v1Schema).build();

/** The TypeScript type for provider account metadata. */
export type ProviderAccountMeta = typeof providerAccountMeta.Type;
