import { DEFAULT_NPM_REGISTRY_ID, type InstallOption } from '../capability';
import type { InstallSourceIntent } from './types';

/** Intent only: selection and measurements belong to the host's actual installer. */
export function installSourceIntent(
  option: InstallOption,
  choices: readonly InstallOption[],
  registry?: string,
): InstallSourceIntent {
  if (registry !== undefined) return { kind: 'explicit', registry };
  const target = option.target;
  const registries = choices.filter((choice) => choice.method === option.method
    && target?.kind === 'mise' && choice.target?.kind === 'mise'
    && JSON.stringify(choice.target) === JSON.stringify(target))
    .flatMap((choice) => choice.registry ? [choice.registry] : []);
  return { kind: 'automatic', registries: [...new Set(registries)], fallbackRegistry: option.registry ?? DEFAULT_NPM_REGISTRY_ID };
}
