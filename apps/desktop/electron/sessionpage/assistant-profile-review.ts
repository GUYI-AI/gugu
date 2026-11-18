import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderAssistantRule, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { assistantRules } from '../assistant-rules-resolver'
import type { PanelPreparedAdmission } from './assistant-panel-admission'

/**
 * Run at the final host admission, including warm native sessions. Neither history nor auto-memory is a receipt. Every turn:
 * the rules come from memory (assistant-rules-resolver.ts), one snapshot for both the version compared and the notice.
 */
export async function prepareAssistantProfileReview(admission: PanelPreparedAdmission, memoryDir: string): Promise<PanelPreparedAdmission> {
  const profile = join(memoryDir, 'owner-profile.md'), index = join(memoryDir, 'MEMORY.md')
  let unavailable = false, current: string | undefined
  try { await access(profile) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return admission; unavailable = true }
  try {
    const text = await readFile(index, 'utf8')
    const lines = text.split(/\r?\n/).filter(line => /\]\((?:\.\/)?owner-profile\.md\)/.test(line))
    if (lines.length === 1) current = lines[0]!.match(/\bprofile_rules:\s*(\d+)\b/)?.[1]
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable = true }
  const { rules } = await assistantRules().available()
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
