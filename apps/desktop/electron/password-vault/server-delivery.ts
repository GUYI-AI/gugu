import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { createDeviceKeyPair, keyPairFromSeed, type DeviceKeyPair } from './sync-crypto'

/**
 * 「本机送」(#2481): an Agent on a Gugu server uses a password the person's desktop keeps. The server never holds a
 * vault key. It asks the account's desktop over the device RPC; the desktop applies the credential's grants or asks
 * the person, and on use seals that one account and password to this server's own key. The server types them into a
 * private browser context (server-private-login.ts). Assumed for now: the server key travels with the request, so a
 * compromised cloud relaying it could stand in for the server (pinning it is a follow-up).
 */
export const PASSWORD_AGENT_RPC = 'password.agent'

// The same id shapes the vault's audit accepts: a malformed one must be refused here, never fail an audit write.
export const remoteCallerSchema = z.strictObject({ deviceId: z.string().uuid(), sessionId: z.string().uuid(), agentId: z.string().uuid(),
  agentName: z.string().max(200), sessionTitle: z.string().max(500) })
export type RemoteCaller = z.infer<typeof remoteCallerSchema>
const fields = z.array(z.strictObject({ name: z.string().trim().min(1).max(200), value: z.string().max(65536).optional(), secret: z.boolean().optional() })).max(50)
export const remoteOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list'), caller: remoteCallerSchema }),
  z.strictObject({ op: z.literal('request'), caller: remoteCallerSchema, credentialId: z.string().uuid(), origin: z.string().url() }),
  z.strictObject({ op: z.literal('status'), caller: remoteCallerSchema, requestId: z.string().uuid() }),
  z.strictObject({ op: z.literal('release'), caller: remoteCallerSchema, requestId: z.string().uuid(), serverKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }),
  z.strictObject({ op: z.literal('save'), caller: remoteCallerSchema, origin: z.string().url(), credentialId: z.string().uuid().optional(), name: z.string().max(200).optional(),
    account: z.string().max(4096).optional(), accountSecret: z.boolean().optional(), password: z.string().max(65536).optional(), fields: fields.optional() }),
  z.strictObject({ op: z.literal('saveStatus'), caller: remoteCallerSchema, requestId: z.string().uuid() }),
])
export type RemoteOp = z.infer<typeof remoteOpSchema>
/** What the server opens: the one account and password, nothing else of the credential. */
export const releasedSchema = z.strictObject({ account: z.string(), password: z.string() })

/** This server's delivery key: one Ed25519 seed in the server's private home (0600), made on first use. */
export async function serverDeliveryKey(home: string): Promise<DeviceKeyPair> {
  const file = path.join(home, 'password-delivery-key')
  try {
    const seed = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64')
    if (seed.length === 32) return await keyPairFromSeed(seed)
  } catch { /* none yet, or unreadable: make a new one */ }
  const pair = await createDeviceKeyPair()
  await mkdir(home, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, pair.secretKey.toString('base64'), { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
  return pair
}
