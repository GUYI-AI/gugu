// #1931 A small neutral set of assistant product rules, for tests only. The product's own words are the assistant App's
// and are not in this repository; these exercise the host's format, slots and read points with placeholder text. Every
// slot each key may use is used, so a render that loses or misplaces a value shows.
import { ASSISTANT_RULES_FORMAT, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'

export const NEUTRAL_ASSISTANT_RULES: AssistantProductRules = Object.freeze({
  format: ASSISTANT_RULES_FORMAT,
  rulesVersion: 'neutral-1',
  defaults: Object.freeze({
    childHarness: 'claude',
    defaultModel: 'platform:neutral-model',
    deniedTools: Object.freeze(['CronCreate']),
    profileRulesVersion: 3,
  }),
  labels: Object.freeze({
    ownerProfileMemoryName: 'Owner',
    ownerProfileMemoryDescription: 'What the owner said at setup',
    ownerProfileIndexDescription: 'the owner',
    ownerProfileNameLine: 'Name: {{preferredName}}',
    ownerProfileLanguageLine: 'Language at setup: {{language}}',
    profileReviewUnverified: 'The profile could not be read.',
  }),
  intro: Object.freeze({
    'en-US': Object.freeze({ title: 'Neutral title', summary: 'Neutral summary.', desktopBody: 'Neutral desktop row.', phoneBody: 'Neutral phone row.' }),
    'zh-CN': Object.freeze({ title: '中性标题', summary: '中性一句话。', desktopBody: '中性桌面行。', phoneBody: '中性手机行。' }),
  }),
  texts: Object.freeze({
    'brief-cloud': '# Brief (cloud)\nIndex: {{memoryIndex}}\nContext: {{workingContext}}\nReference: {{reference}}',
    'brief-computer': '# Brief (computer)\nIndex: {{memoryIndex}}\nContext: {{workingContext}}\nReference: {{reference}}',
    'guide-cloud': '# Guide (cloud)\nProfile rules: {{profileRulesVersion}}',
    'guide-computer': '# Guide (computer)\nProfile rules: {{profileRulesVersion}}',
    recovery: 'Recover: {{workingContext}} {{pendingWork}} {{memoryIndex}}',
    'first-task': 'Neutral first task.',
    'task-execution': 'Neutral task execution.',
    'executor-report': 'Neutral executor report.',
    'task-agent-identity': 'Neutral task agent identity.',
    'profile-review': 'Review the profile under rules {{profileRulesVersion}}.',
  }),
})
