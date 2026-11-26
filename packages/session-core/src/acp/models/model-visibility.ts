/** Internal approval reviewers are callable infrastructure, never a person's main chat model. */
export function isUserFacingModelId(id: string): boolean {
  return id.trim().toLowerCase() !== 'codex-auto-review';
}

/**
 * A harness alias that names no model of its own ("default", "Default (recommended)", 「默认」).
 * Owner 11-24 / 11-25: a model list shows concrete models only; such a row is resolved to the
 * model it stands for, or not shown at all (`concreteModelName`).
 */
export function isPlaceholderModel(id: string, name: string | undefined): boolean {
  return id.trim().toLowerCase() === 'default' || /^default\b/i.test(name?.trim() ?? '') || /默认/.test(name ?? '');
}

/**
 * The concrete model a placeholder stands for, as its harness states it in the description
 * (Claude 2.1.x: `default` → "Opus 5 with 1M context"). Only a model name at the head of the
 * description counts — prose that merely mentions a model resolves to nothing.
 */
export function concreteModelName(description: string | undefined, knownNames: readonly string[]): string | null {
  const text = description?.trim();
  if (!text) return null;
  const startsWith = (name: string) =>
    text.toLowerCase().startsWith(name.toLowerCase()) && !/[\w.]/.test(text.charAt(name.length));
  const known = knownNames.filter(startsWith).sort((a, b) => b.length - a.length)[0];
  if (known) return known;
  return /^(?:Opus|Fable|Sonnet|Haiku) \d+(?:\.\d+)*(?![\w.])/i.exec(text)?.[0] ?? null;
}
