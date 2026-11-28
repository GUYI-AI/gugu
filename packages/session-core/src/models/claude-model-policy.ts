/**
 * Which models Claude Code lets a session name, as the review rule reads it: a reviewer the policy blocks is dropped
 * by the CLI without a word ("ignoring CLAUDE_CODE_AUTO_MODE_MODEL … because your organization's model policy does
 * not allow it") and the main model reviews instead.
 *
 * The matching follows https://code.claude.com/docs/en/model-config#restrict-model-selection and was checked against
 * Claude Code 2.1.318 (claude-model-policy.test.ts lists the cases). Summary:
 *  · `availableModels`: a family (`haiku`), a version prefix that matches at a `-` boundary (`claude-haiku-5` lets
 *    `claude-haiku-5-5` through, `claude-hai` does not), or a full id. An id entry is matched on the name as given,
 *    so `claude-haiku-5-5` does not let `anthropic/claude-haiku-5-5` through; a family matches either spelling.
 *    A specific entry in a family turns that family's wildcard off. Case and a `[1m]` tag do not matter.
 *  · `availableModelsMatch: "exact"`: an id entry lets only its own version through: itself and its dated and
 *    `-fast` ids (the CLI's settings schema says so).
 *  · `deniedModels`: a family, or an id that blocks that version and its later releases in every spelling.
 */
export type ClaudeModelPolicy = {
  /** The `availableModels` in force; null = none, every model may be named. */
  available: readonly string[] | null;
  /** Managed `deniedModels` (the CLI reads it from managed settings only). */
  denied: readonly string[];
  /** Managed `availableModelsMatch: "exact"`. */
  exact: boolean;
};

export const NO_CLAUDE_MODEL_POLICY: ClaudeModelPolicy = { available: null, denied: [], exact: false };

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

const canonical = (id: string) => id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');

/** A provider spelling (`anthropic/…`, `us.anthropic.…`) as the plain Claude id. */
const plainClaudeId = (id: string) => id.slice(id.lastIndexOf('/') + 1).replace(/^(?:[a-z-]+\.)?anthropic\./, '');

function familyOf(id: string): string | undefined {
  return /^claude-(?:\d+(?:-\d+)*-)?(opus|sonnet|haiku|fable)(?=$|[-@])/.exec(plainClaudeId(id))?.[1];
}

const extendsEntry = (name: string, entry: string) => name === entry || name.startsWith(`${entry}-`);

export function claudeModelAllowed(name: string, policy: ClaudeModelPolicy): boolean {
  const model = canonical(name);
  const family = familyOf(model);
  const plain = plainClaudeId(model);
  const denied = policy.denied.map(canonical).filter(Boolean);
  if (denied.some(entry => FAMILIES.includes(entry)
    ? entry === family
    : extendsEntry(plain, plainClaudeId(entry)) || plain.startsWith(`${plainClaudeId(entry)}@`))) return false;
  if (!policy.available) return true;
  const entries = policy.available.map(canonical).filter(Boolean);
  return entries.some(entry => {
    if (FAMILIES.includes(entry)) return entry === family && !entries.some(other => !FAMILIES.includes(other) && familyOf(other) === entry);
    if (policy.exact) return model === entry || (model.startsWith(entry) && /^(?:-\d{8}|-fast)+$/.test(model.slice(entry.length)));
    return extendsEntry(model, entry);
  });
}
