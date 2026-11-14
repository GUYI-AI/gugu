import type {
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from '@agentclientprotocol/sdk';

const isOptionObject = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** ACP selects contain either individual options or named groups of options. */
export function flattenSelectOptions(
  options: SessionConfigSelectOptions = [],
): SessionConfigSelectOption[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry) => {
    if (!isOptionObject(entry)) return [];
    if ('group' in entry || 'options' in entry) {
      return 'options' in entry && Array.isArray(entry.options)
        ? entry.options.filter(isOptionObject)
        : [];
    }
    return [entry];
  });
}
