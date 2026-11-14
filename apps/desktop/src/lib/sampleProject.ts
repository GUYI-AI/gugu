import { readUserSettingsConfig, updateUserSettingsConfig, type VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings'
import { rendererLogger } from './log'
import { identityDb } from './supabase'

// The sample project (#709) is bundled content: no project, folder, group, message or agent rows exist
// for it. This one account key is the only thing that decides whether it is shown. Only the new
// first-run intro writes it, so accounts that existed before never get the sample; a dismissal keeps
// the key, so the sample never comes back on any device.
// #2569 the first message sent in the sample turns it into a real project. Version 2 records how far that got:
// `projectId` once the project exists (a retry or another window continues with it, ❌ makes a second one), `chatId`
// once its files are written and its group exists (the sample gives way wherever that project is listed).
export type SampleProjectState =
  | { version: 1; dismissed: boolean }
  | { version: 2; dismissed: boolean; projectId: string; chatId?: string }
const KEY = 'sampleProject'
const client = identityDb as unknown as VersionedSettingsTableClient
const log = rendererLogger('sample-project')
const listeners = new Set<(userId: string) => void>()

export function parseSampleProject(config: Record<string, unknown>): SampleProjectState | null {
  const value = config[KEY]
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sample project state')
  const { version, dismissed, projectId, chatId } = value as Record<string, unknown>
  if (typeof dismissed !== 'boolean') throw new Error('Invalid sample project state')
  if (version === 1) return { version: 1, dismissed }
  if (version !== 2 || typeof projectId !== 'string' || !projectId || (chatId !== undefined && (typeof chatId !== 'string' || !chatId))) {
    throw new Error('Invalid sample project state')
  }
  return { version: 2, dismissed, projectId, ...(chatId ? { chatId } : {}) }
}

/** Read failures propagate: the caller shows no sample and logs, ❌ guesses either way. */
export async function readSampleProject(userId: string): Promise<SampleProjectState | null> {
  return parseSampleProject(await readUserSettingsConfig(client, userId, 'user'))
}

export async function readSampleProjectShown(userId: string): Promise<boolean> {
  const state = await readSampleProject(userId)
  return state !== null && !state.dismissed
}

/** The main window is already mounted under the intro, so whoever shows the sample re-reads on change. */
export function subscribeSampleProject(listener: (userId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function notifySampleProject(userId: string): void {
  for (const listener of listeners) {
    try {
      listener(userId)
    } catch (error) {
      log.error({ error: String(error) }, 'sample project listener failed')
    }
  }
}

/** Keep the key as a tombstone. Only acknowledge removal after the account save succeeds. */
export async function dismissSampleProject(userId: string): Promise<void> {
  await updateUserSettingsConfig(client, userId, 'user', (config) => {
    const state = parseSampleProject(config)
    return { ...config, [KEY]: state?.version === 2 ? { ...state, dismissed: true } : { version: 1, dismissed: true } }
  })
  notifySampleProject(userId)
}

/**
 * #2569 Record how far turning the sample into a project got, on the latest row (another window may have written since).
 * A key that is gone or malformed is not guessed over: the save fails and says so.
 */
export async function recordSampleProjectConversion(userId: string, became: { projectId: string; chatId?: string }): Promise<void> {
  await updateUserSettingsConfig(client, userId, 'user', (config) => {
    const state = parseSampleProject(config)
    if (!state) throw new Error('This account has no sample project to turn into a project')
    return { ...config, [KEY]: { version: 2, dismissed: state.dismissed, projectId: became.projectId, ...(became.chatId ? { chatId: became.chatId } : {}) } }
  })
  notifySampleProject(userId)
}

/**
 * Called when the first-run intro is left, after first-run hints are enrolled. Retrying the intro keeps
 * the existing key. Never throws: a failure only costs this account its sample project and must not
 * keep the person out of the app.
 */
export async function enrollSampleProject(userId: string): Promise<void> {
  try {
    const config = await readUserSettingsConfig(client, userId, 'user')
    if (parseSampleProject(config)) return
    // The first read may predate a removal on another window/device. Recheck the
    // latest row on every conditional-write attempt instead of replacing its key.
    await updateUserSettingsConfig(client, userId, 'user', (latest) => parseSampleProject(latest)
      ? latest : { ...latest, [KEY]: { version: 1, dismissed: false } })
  } catch (error) {
    log.error({ error: String(error) }, 'enroll sample project failed')
    return
  }
  notifySampleProject(userId)
}
