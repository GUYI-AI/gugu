// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import { PromptEditor } from '../../../packages/session-ui/src/react/components/prompt-editor/prompt-editor'
import type { PromptEditorRef } from '../../../packages/session-ui/src/react/components/prompt-editor/types'
import { creationSkillInput } from '../../../apps/desktop/src/components/session-watch/create-skill-draft'
import { createReactHarness } from '../../support/testHarness'

const harness = createReactHarness()
afterEach(() => harness.cleanup())
it('keeps a selected skill as an inline component through editing and draft restoration, and deletes it with its reference', async () => {
  let editor: PromptEditorRef | null = null
  await harness.render(createElement(PromptEditor, { ref: value => { editor = value } }))
  const skill = { id: '/workspace/skills/review-agent/SKILL.md', name: 'review-agent', description: 'Review changes' }
  await act(async () => creationSkillInput(item => editor!.insertMention(item)).update([skill]))
  expect(harness.container.querySelector('[data-skill-reference]')?.textContent).toContain('review-agent')
  expect(harness.container.querySelector('[data-skill-reference]')?.closest('[contenteditable]')).not.toBeNull()
  await act(async () => editor!.insertText('检查这次修改', 'end'))
  const text = editor!.getText()
  expect(text).toContain('@[review-agent](/workspace/skills/review-agent/SKILL.md)')
  expect(text).toContain('检查这次修改')
  expect(text).not.toContain('请使用以下技能')
  await act(async () => { editor!.clear(); editor!.setText(text) })
  expect(harness.container.querySelectorAll('[data-skill-reference]')).toHaveLength(1)
  expect(editor!.getText()).toBe(text)
  await act(async () => editor!.removeMention(skill.id))
  expect(harness.container.querySelector('[data-skill-reference]')).toBeNull()
  expect(editor!.getText()).not.toContain('SKILL.md')
  expect(editor!.getText()).toContain('检查这次修改')
})
