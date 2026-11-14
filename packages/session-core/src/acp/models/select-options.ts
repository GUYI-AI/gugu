import type {
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from '@agentclientprotocol/sdk';

/** ACP selects contain either individual options or named groups of options. */
export function flattenSelectOptions(
  options: SessionConfigSelectOptions = [],
): SessionConfigSelectOption[] {
  return options.flatMap((entry) => 'options' in entry ? entry.options : [entry]);
}
