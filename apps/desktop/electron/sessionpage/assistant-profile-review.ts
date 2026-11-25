import { access, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { renderAssistantRule, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { assistantRules } from '../assistant-rules-resolver'
import type { PanelPreparedAdmission } from './assistant-panel-admission'

/** Proof of bytes written by this process during a fresh home preparation; never persisted or synchronized. */
export interface FreshAssistantProfile {
  readonly profile: string
  readonly index: string
  readonly rules: string
}
const freshProfiles = new Map<string, FreshAssistantProfile>()
const claimedProfiles = new WeakSet<FreshAssistantProfile>()
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const ruleVersion = (rules: AssistantProductRules) => JSON.stringify([rules.rulesVersion,rules.defaults.profileRulesVersion])

export function forgetFreshAssistantProfile(memoryDir: string): void { freshProfiles.delete(resolve(memoryDir)) }
export function rememberFreshAssistantProfile(memoryDir: string, profile: string, index: string, rules: AssistantProductRules): void {
  freshProfiles.set(resolve(memoryDir), { profile: digest(profile), index: digest(index), rules: ruleVersion(rules) })
}
/** Claim before asynchronous admission: rejection, timeout and a second turn cannot reuse it. */
export function takeFreshAssistantProfile(memoryDir: string): FreshAssistantProfile | undefined {
  const key = resolve(memoryDir), proof = freshProfiles.get(key)
  freshProfiles.delete(key)
  if (proof) claimedProfiles.add(proof)
  return proof
}

/**
 * Run at the final host admission, including warm native sessions. Neither history nor auto-memory is a receipt. Every turn:
 * the rules come from memory (assistant-rules-resolver.ts), one snapshot for both the version compared and the notice.
 */
export async function prepareAssistantProfileReview(admission: PanelPreparedAdmission, memoryDir: string, fresh?: FreshAssistantProfile): Promise<PanelPreparedAdmission> {
  const claimed = fresh ? claimedProfiles.delete(fresh) : false
  const profile = join(memoryDir, 'owner-profile.md'), index = join(memoryDir, 'MEMORY.md')
  let indexBytes: Buffer | undefined
  let unavailable = false, current: string | undefined
  try { await access(profile) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return admission; unavailable = true }
  try {
    indexBytes = await readFile(index)
    const text = indexBytes.toString('utf8')
    const lines = text.split(/\r?\n/).filter(line => /\]\((?:\.\/)?owner-profile\.md\)/.test(line))
    if (lines.length === 1) current = lines[0]!.match(/\bprofile_rules:\s*(\d+)\b/)?.[1]
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable = true }
  const { rules } = await assistantRules().available()
  if (claimed && fresh && !unavailable && indexBytes && fresh.index === digest(indexBytes) && fresh.rules === ruleVersion(rules)) {
    const bytes = await readFile(profile).catch(() => undefined)
    if (bytes && fresh.profile === digest(bytes)) return admission
  }
  if (!unavailable && current === String(rules.defaults.profileRulesVersion)) return admission
  const review = assistantProfileReviewText(unavailable, rules)
  return { ...admission, beforeText: [admission.beforeText, review].filter(Boolean).join('\n\n') }
}

/** The review notice: the product's words inside the host's tag, with the version the host compares above. */
export function assistantProfileReviewText(unverified: boolean, rules: AssistantProductRules): string {
  return [
    '<gugu_profile_review>',
    ...(unverified ? [rules.labels.profileReviewUnverified] : []),
    renderAssistantRule(rules.texts['profile-review'], { profileRulesVersion: String(rules.defaults.profileRulesVersion) }),
    '</gugu_profile_review>',
  ].join('\n')
}
