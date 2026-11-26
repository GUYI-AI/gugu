import { useEffect, useState } from 'react';
import { SessionModalLayer } from '@/components/SessionModalLayer';
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme';
import { UI_EVENTS } from '@/lib/uiEvents';
import { useTheme } from '@/store/theme';
import type { CustomModelRouteRepairRequest } from '@renderer/lib/open-shell-settings';
import { CustomModelDialog } from './CustomModelDialog';

export function CustomModelRouteRepairHost() {
  const { theme } = useTheme();
  const [request, setRequest] = useState<CustomModelRouteRepairRequest | null>(null);
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<CustomModelRouteRepairRequest>).detail);
    window.addEventListener(UI_EVENTS.repairCustomModelRoute, open);
    return () => window.removeEventListener(UI_EVENTS.repairCustomModelRoute, open);
  }, []);

  if (!request) return null;
  return <SessionModalLayer><SessionUiTheme theme={theme} skin>
    <CustomModelDialog machine={request.machine} connection={request.connection} initialRoute={request.route} modelId={request.route.modelId}
      onClose={() => { setRequest(null); request.onClose(); }} />
  </SessionUiTheme></SessionModalLayer>;
}
