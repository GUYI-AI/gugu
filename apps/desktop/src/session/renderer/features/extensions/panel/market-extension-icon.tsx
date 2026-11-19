import { useState } from 'react';
import { ExtensionMonogram } from './extension-monogram';

export function MarketExtensionIcon({ name, iconUrl }: { name: string; iconUrl?: string | null }) {
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const loaded = !!iconUrl && loadedUrl === iconUrl;
  return (
    <span className="mk-icon mk-market-extension-icon">
      {!loaded && <ExtensionMonogram name={name} />}
      {iconUrl && <img
        src={iconUrl}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        className="xp-glyph-img"
        data-loaded={loaded}
        onLoad={() => setLoadedUrl(iconUrl)}
        onError={() => setLoadedUrl(undefined)}
      />}
    </span>
  );
}
