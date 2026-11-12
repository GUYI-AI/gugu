/**
 * The personal assistant's product rules as data (#1931): what the host reads, never runs.
 *
 * The host owns this format and every read point; the product owns the words and defaults. They are not in this
 * repository: the product's assistant App supplies them as text/data files (`contributes.assistantRules`, validated by
 * @shared/extensions/assistant-rules-parse), honoured only for the App the host trusts as the product's rules provider.
 * Strings and pure functions only: the cloud host and both desktop processes import this.
 */

/** The data format this host reads. A rules folder declaring any other number is refused, never guessed at. */
export const ASSISTANT_RULES_FORMAT = 1

/**
 * Every multi-line text, by key, and the slots the host fills into it (`{{name}}`). The host computes each value
 * (paths, versions) and adds the surrounding markers or tags; the text is everything between them.
 */
export const ASSISTANT_RULES_TEXT_SLOTS = {
  /** The resident brief in the managed block of the assistant's instructions file, for an assistant in the cloud. */
  'brief-cloud': ['memoryIndex', 'workingContext', 'reference'],
  /** The same brief for an assistant on a person's computer. */
  'brief-computer': ['memoryIndex', 'workingContext', 'reference'],
  /** The full handbook written next to the instructions file (the brief points at it), cloud. */
  'guide-cloud': ['profileRulesVersion'],
  /** The full handbook, computer. */
  'guide-computer': ['profileRulesVersion'],
  /** Inside `<gugu_assistant_recovery>`, replayed when the assistant's context is rebuilt. */
  recovery: ['workingContext', 'pendingWork', 'memoryIndex'],
  /** The first task the system hands a newly set-up assistant. */
  'first-task': [],
  /** Inside `<gugu_task_context>`, appended to every task the assistant dispatches. */
  'task-execution': [],
  /** The `report` field of `<gugu_work>`: how an executor reports back to the assistant. */
  'executor-report': [],
  /** Leads the system prompt of a one-off executor that shares the assistant's directory. */
  'task-agent-identity': [],
  /** Inside `<gugu_profile_review>`, before an owner turn while the profile is not reviewed under the current rules. */
  'profile-review': ['profileRulesVersion'],
} as const satisfies Record<string, readonly string[]>

/** Single-line wording, by key, and its slots. */
export const ASSISTANT_RULES_LABEL_SLOTS = {
  /** `name:` of the owner-profile memory file, and its link text in MEMORY.md. */
  ownerProfileMemoryName: [],
  /** `description:` of the owner-profile memory file. */
  ownerProfileMemoryDescription: [],
  /** What MEMORY.md says after the owner-profile link. */
  ownerProfileIndexDescription: [],
  /** The owner-profile line naming how the person is addressed. */
  ownerProfileNameLine: ['preferredName'],
  /** The owner-profile line naming the interface language at setup. */
  ownerProfileLanguageLine: ['language'],
  /** Added to the profile review when the host could not read the profile or its index. */
  profileReviewUnverified: [],
} as const satisfies Record<string, readonly string[]>

export type AssistantRulesTextKey = keyof typeof ASSISTANT_RULES_TEXT_SLOTS
export type AssistantRulesLabelKey = keyof typeof ASSISTANT_RULES_LABEL_SLOTS

/**
 * What the first-run introduction says about the assistant, in one interface language. The host draws that page (the
 * avatar, the buttons, the rows about its own places); these are the product's words on it. Never part of what the
 * assistant is told.
 */
export type AssistantIntroCopy = {
  /** The page's heading. */
  title: string
  /** The one sentence a desktop's first run shows under the heading. */
  summary: string
  /** The assistant's row where the page lists rows instead, on a computer-sized screen. */
  desktopBody: string
  /** The same row on a phone. */
  phoneBody: string
}

export type AssistantProductRules = {
  format: typeof ASSISTANT_RULES_FORMAT
  /** The product's own label for this set of rules (logged and cached by it; never compared for order). */
  rulesVersion: string
  defaults: {
    /** The harness the assistant's child agents use when it names none. */
    childHarness: string
    /** The model a newly set-up assistant starts on when platform models are available. */
    defaultModel: string
    /** Native tools denied in the assistant's settings. */
    deniedTools: readonly string[]
    /** The owner-profile rules version: the host re-reviews a profile whose MEMORY.md line records another. */
    profileRulesVersion: number
  }
  labels: Readonly<Record<AssistantRulesLabelKey, string>>
  /**
   * The first-run introduction's words, by interface locale (`zh-CN`, `en-US`). Optional: without the person's locale the
   * host shows its own neutral heading and nothing about the assistant.
   */
  intro?: Readonly<Record<string, Readonly<AssistantIntroCopy>>>
  texts: Readonly<Record<AssistantRulesTextKey, string>>
}

const SLOT = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g

/** The slot names a template uses, in order of first use. */
export function assistantRuleSlots(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(SLOT), match => match[1]!))]
}

/**
 * Fills a template's slots in one pass (a value is never re-read as a template). A slot without a value throws:
 * the loader has already refused templates naming slots their key does not have.
 */
export function renderAssistantRule(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(SLOT, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`assistant rule slot {{${name}}} has no value here`)
    return value
  })
}

/** Text files of a rules folder: `<key>.md`, the text followed by one newline. */
export const assistantRuleTextFile = (key: AssistantRulesTextKey) => `${key}.md`
export const ASSISTANT_RULES_DATA_FILE = 'rules.json'

/** The files of a rules folder holding these rules (the inverse of the desktop loader). */
export function assistantRulesFiles(rules: AssistantProductRules): Record<string, string> {
  const files: Record<string, string> = {
    [ASSISTANT_RULES_DATA_FILE]: `${JSON.stringify({ format: rules.format, rulesVersion: rules.rulesVersion, defaults: rules.defaults, labels: rules.labels, ...(rules.intro ? { intro: rules.intro } : {}) }, null, 2)}\n`,
  }
  for (const key of Object.keys(ASSISTANT_RULES_TEXT_SLOTS) as AssistantRulesTextKey[]) files[assistantRuleTextFile(key)] = `${rules.texts[key]}\n`
  return files
}
