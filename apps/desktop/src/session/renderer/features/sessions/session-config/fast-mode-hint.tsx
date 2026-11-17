import type { ReactElement } from 'react';
import { Hint } from '@/components/ui/Tooltip';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** The shared composer calls this only on desktop; phones keep the icon alone. */
export function renderFastModeHint(button: ReactElement) {
  return <Hint label={translateSessionMessage('composer.fastModeHint')} side="top">{button}</Hint>;
}
