import { beforeAll, expect, it, vi } from 'vitest'
import { installAssistantRulesResolver } from '../../../apps/desktop/electron/assistant-rules-resolver'
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { fixedAssistantRules } from './assistantRules/fixtureApp'
import { NEUTRAL_ASSISTANT_RULES } from './assistantRules/neutralRules'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAssistantProfileReview } from '../../../apps/desktop/electron/sessionpage/assistant-profile-review'

// The review notice's words are the assistant App's (#1931): fixed rules here, at the version the index lines below name.
// The host compares that version and wraps the App's text in its tag; the wording itself is the App's to test.
const rules: AssistantProductRules = { ...NEUTRAL_ASSISTANT_RULES, defaults: { ...NEUTRAL_ASSISTANT_RULES.defaults, profileRulesVersion: 6 } }
beforeAll(() => installAssistantRulesResolver(fixedAssistantRules(rules)))
const notice = (unverified = false) =>
  ['<gugu_profile_review>', ...(unverified ? [rules.labels.profileReviewUnverified] : []), 'Review the profile under rules 6.', '</gugu_profile_review>'].join('\n')

it('checks the live index on warm turns and retries until the model saves a verified review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-review-')), index = join(root, 'MEMORY.md')
  const admission = { text: 'hi', accepted: vi.fn(async () => {}) }
  try {
    await writeFile(join(root, 'owner-profile.md'), '姓名：测试\n怎么称呼：不写主人\n')
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toBe(notice())
    await writeFile(index, '- [关于你](owner-profile.md) — 事实；profile_rules: 2\n')
    const stale = await readFile(index, 'utf8')
    const first = await prepareAssistantProfileReview(admission, root)
    expect(first.beforeText).toBe(notice())
    expect(first.text).toBe('hi')
    expect(first.accepted).toBe(admission.accepted)
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toBe(notice())
    expect(await readFile(index, 'utf8')).toBe(stale)
    await writeFile(index, '- [偏好](feedback.md) profile_rules: 6\n- [关于你](owner-profile.md) profile_rules: 2\n')
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toBe(notice())
    await writeFile(index, '- [关于你](owner-profile.md) — 事实；profile_rules: 6\n')
    expect(await prepareAssistantProfileReview(admission, root)).toBe(admission)
    expect(await prepareAssistantProfileReview(admission, root)).toBe(admission)
    await rm(index); await mkdir(index)
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toBe(notice(true))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not create or request a profile when none exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-absent-'))
  try {
    const admission = { text: 'hi', accepted: async () => {} }
    expect(await prepareAssistantProfileReview(admission, root)).toBe(admission)
    await expect(readFile(join(root, 'owner-profile.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
