import { useContext, useEffect, useState } from 'react';
import { SurfaceShownContext } from '@/lib/retainedSurface';

/** Close portal details when the retained marketplace is hidden. */
export function useLibrarySheetSelection(inSettings = false, initialId?: string): [string | null, (id: string | null) => void] {
  const marketShown = useContext(SurfaceShownContext);
  const showing = inSettings || marketShown;
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  useEffect(() => {
    if (!showing) setSelected(null);
  }, [showing]);
  return [showing ? selected : null, setSelected];
}
