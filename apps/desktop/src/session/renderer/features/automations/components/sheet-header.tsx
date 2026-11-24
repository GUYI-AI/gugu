import { X } from '@/lib/icons'
import { Button } from '@renderer/lib/ui/button';
import { MicroLabel } from '@renderer/lib/ui/label';
import { SHEET_SAFE_INSET_RIGHT } from '@renderer/lib/ui/sheet';

export function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div
      className="flex flex-row items-center justify-between gap-1.5 p-4"
      // 右内距和别的抽屉头同一个数(sheet.tsx SHEET_SAFE_INSET_RIGHT)。
      style={{ paddingRight: SHEET_SAFE_INSET_RIGHT }}
    >
      <MicroLabel>{title}</MicroLabel>
      <Button variant="ghost" size="sm" onClick={onClose} className="p-0">
        <X className="size-4" />
      </Button>
    </div>
  );
}
