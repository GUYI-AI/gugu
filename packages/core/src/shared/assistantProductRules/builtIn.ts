// The personal assistant's built-in product rules (#1931): the words and defaults the host reads at its read points,
// one module per kind of rule. They are the only source today. An installed App can carry the same shape as files
// (assistantRulesFormat.ts); until the host trusts one, nothing reads those.
import { ASSISTANT_RULES_FORMAT, type AssistantProductRules } from '../assistantRulesFormat'
import { ASSISTANT_CHILD_HARNESS, ASSISTANT_DEFAULT_MODEL, ASSISTANT_DENIED_TOOLS, PROFILE_RULES_VERSION } from './defaults'
import { ASSISTANT_FIRST_TASK } from './firstTask'
import { ASSISTANT_INTRO } from './intro'
import {
  ASSISTANT_PROFILE_REVIEW, ASSISTANT_PROFILE_REVIEW_UNVERIFIED, OWNER_PROFILE_INDEX_DESCRIPTION, OWNER_PROFILE_LANGUAGE_LINE,
  OWNER_PROFILE_MEMORY_DESCRIPTION, OWNER_PROFILE_MEMORY_NAME, OWNER_PROFILE_NAME_LINE,
} from './ownerProfile'
import { ASSISTANT_BRIEF, ASSISTANT_GUIDE, ASSISTANT_RECOVERY } from './role'
import { ASSISTANT_EXECUTOR_REPORT, ASSISTANT_TASK_AGENT_IDENTITY, ASSISTANT_TASK_EXECUTION } from './workflow'

export const BUILT_IN_ASSISTANT_RULES: AssistantProductRules = Object.freeze({
  format: ASSISTANT_RULES_FORMAT,
  rulesVersion: 'built-in',
  defaults: Object.freeze({
    childHarness: ASSISTANT_CHILD_HARNESS,
    defaultModel: ASSISTANT_DEFAULT_MODEL,
    deniedTools: ASSISTANT_DENIED_TOOLS,
    profileRulesVersion: PROFILE_RULES_VERSION,
  }),
  labels: Object.freeze({
    ownerProfileMemoryName: OWNER_PROFILE_MEMORY_NAME,
    ownerProfileMemoryDescription: OWNER_PROFILE_MEMORY_DESCRIPTION,
    ownerProfileIndexDescription: OWNER_PROFILE_INDEX_DESCRIPTION,
    ownerProfileNameLine: OWNER_PROFILE_NAME_LINE,
    ownerProfileLanguageLine: OWNER_PROFILE_LANGUAGE_LINE,
    profileReviewUnverified: ASSISTANT_PROFILE_REVIEW_UNVERIFIED,
  }),
  intro: ASSISTANT_INTRO,
  texts: Object.freeze({
    'brief-cloud': ASSISTANT_BRIEF.cloud,
    'brief-computer': ASSISTANT_BRIEF.computer,
    'guide-cloud': ASSISTANT_GUIDE.cloud,
    'guide-computer': ASSISTANT_GUIDE.computer,
    recovery: ASSISTANT_RECOVERY,
    'first-task': ASSISTANT_FIRST_TASK,
    'task-execution': ASSISTANT_TASK_EXECUTION,
    'executor-report': ASSISTANT_EXECUTOR_REPORT,
    'task-agent-identity': ASSISTANT_TASK_AGENT_IDENTITY,
    'profile-review': ASSISTANT_PROFILE_REVIEW,
  }),
})
