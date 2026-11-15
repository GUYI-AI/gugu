import type { IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { OPENCODE_REASONING_VARIANTS } from '../../helpers/opencode-family-model-config';
import { openCodeFamilyConfigContent } from '../../helpers/opencode-family-platform-model';
import { harnessPlatform } from './platform';

const KILO_REASONING = { displayName: 'Kilo', reasoningVariants: OPENCODE_REASONING_VARIANTS } as const;

export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_KILOCODE_MODEL'),
    ...(input.requestedEffort ? { reasoningEffort: input.requestedEffort } : {}),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  load: (model) =>
    openCodeFamilyConfigContent('KILO_CONFIG_CONTENT', harnessPlatform.wireProtocol, model, KILO_REASONING),
};
