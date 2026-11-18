/** Internal approval reviewers are callable infrastructure, never a person's main chat model. */
export function isUserFacingModelId(id: string): boolean {
  return id.trim().toLowerCase() !== 'codex-auto-review';
}
