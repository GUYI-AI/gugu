import { useContext, useEffect, useState } from 'react';
import { SurfaceShownContext } from '@/lib/retainedSurface';

/** Close portal details when the retained marketplace is hidden. */
export function useLibrarySheetSelection(): [string | null, (id: string | null) => void] {
  const showing = useContext(SurfaceShownContext);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!showing) setSelected(null);
  }, [showing]);
  return [showing ? selected : null, setSelected];
}
