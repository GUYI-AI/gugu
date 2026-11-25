import type { ReactElement } from 'react';
import { Hint } from '@/components/ui/Tooltip';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/**
 * The shared composer calls this only on desktop; phones keep the icon alone. What Fast costs comes from the declaration
 * (`fastTokenMultiplier`): a published token multiple, or only that it is billed higher.
 */
export function fastModeHint(tokenMultiplier: number | undefined) {
  const label = tokenMultiplier
    ? translateSessionMessage('composer.fastModeHintTokens', { multiplier: tokenMultiplier })
    : translateSessionMessage('composer.fastModeHintPrice');
  return (trigger: ReactElement) => <Hint label={label} side="top">{trigger}</Hint>;
}
