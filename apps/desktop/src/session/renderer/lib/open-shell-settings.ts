import { UI_EVENTS } from '@/lib/uiEvents';
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels';
import type { CustomModelConnection, CustomModelRoute } from '@gugu/session-core/models/custom-model';

// 设置只有一个,是壳的弹窗(product spec)。本页只转达「打开它、落到哪一格」;关掉是弹窗自己的事。
export function openShellSettings(section?: ActiveSection, action?: 'add-custom-model'): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section, action } }));
}

export interface CustomModelRouteRepairRequest {
  machine: string | null;
  connection: CustomModelConnection;
  route: Omit<CustomModelRoute, 'id'>;
  onClose: () => void;
}

export function openCustomModelRouteRepair(detail: CustomModelRouteRepairRequest): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.repairCustomModelRoute, { detail }));
}
